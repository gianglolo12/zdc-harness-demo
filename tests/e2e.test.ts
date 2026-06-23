/**
 * End-to-end integration test — full harness flow with in-memory fakes.
 *
 * Real modules wired: buildServer, classify, processJob, handleCommand
 * Stubbed (in-memory fakes): claude runner, GitLab client, queue/state
 *
 * Flow exercised:
 *   (a) GitLab push webhook → POST /webhook → enqueues impact job
 *   (b) processJob(impact) with fake runClaude + reviewSolution → draft MR created
 *   (c) GitLab note webhook `/approve` → enqueues approve; handleCommand → enqueues phase2
 *   (d) processJob(phase2) with fake runClaude → finalizeMR called
 */

import { describe, it, expect, vi } from "vitest"
import { buildServer } from "../src/server.js"
import { classify } from "../src/classifier.js"
import { processJob } from "../src/worker.js"
import { handleCommand } from "../src/pipeline/human-gate.js"
import { InMemoryStateStore } from "../src/state-store.js"
import type { JobIntent, ImpactJobIntent } from "../src/classifier.js"
import type { Phase2JobIntent } from "../src/pipeline/human-gate.js"
import type { WorkerDeps } from "../src/worker.js"
import type { HumanGateDeps } from "../src/pipeline/human-gate.js"
import type { Phase1Deps } from "../src/pipeline/phase1-impact.js"
import type { Phase2Deps } from "../src/pipeline/phase2-implement.js"
import { runPhase1 } from "../src/pipeline/phase1-impact.js"
import { runPhase2 } from "../src/pipeline/phase2-implement.js"

// ─── Fake registry ────────────────────────────────────────────────────────────

const FAKE_REGISTRY = {
  repos: {
    be: {
      sourceRepo: "git@gitlab.example.com/org/be-source.git",
      bundle: "be",
      controlPlaneRef: "main",
    },
  },
}

// ─── In-memory GitLab fake ─────────────────────────────────────────────────────

interface FakeMR {
  iid: number
  title: string
  body: string
  draft: boolean
  comments: string[]
  labels: string[]
}

function makeFakeGitlab() {
  const mrs = new Map<number, FakeMR>()
  let nextIid = 100

  return {
    mrs,
    createDraftMR: vi.fn(async (_projectId: number, title: string, body: string) => {
      const iid = nextIid++
      mrs.set(iid, { iid, title: `Draft: ${title}`, body, draft: true, comments: [], labels: [] })
      return { iid }
    }),
    commentMR: vi.fn(async (_projectId: number, mrIid: number, body: string) => {
      const mr = mrs.get(mrIid)
      if (mr) mr.comments.push(body)
    }),
    getMR: vi.fn(async (_projectId: number, mrIid: number) => mrs.get(mrIid)),
    finalizeMR: vi.fn(async (_projectId: number, mrIid: number) => {
      const mr = mrs.get(mrIid)
      if (mr) mr.draft = false
    }),
    setLabel: vi.fn(async (_projectId: number, mrIid: number, label: string) => {
      const mr = mrs.get(mrIid)
      if (mr) mr.labels.push(label)
    }),
  }
}

// ─── In-memory queue fake ──────────────────────────────────────────────────────

function makeInMemoryQueue() {
  const jobs: JobIntent[] = []
  const enqueuer = {
    enqueue: vi.fn(async (job: JobIntent) => {
      jobs.push(job)
    }),
  }
  return { jobs, enqueuer }
}

// ─── Push webhook payload (feature branch + [zdc:update-be PRD-1] + po/ file) ──

const PUSH_WEBHOOK = {
  object_kind: "push",
  ref: "refs/heads/feature/add-user-endpoint",
  commits: [
    {
      message: "[zdc:update-be PRD-1] add user endpoint impact analysis",
      added: ["po/PRD-1-user-endpoint.md"],
      modified: [],
      removed: [],
    },
  ],
}

// ─── Note webhook payload (/approve on MR) ────────────────────────────────────

function makeApproveNoteWebhook(mrIid: number) {
  return {
    object_kind: "note",
    object_attributes: {
      noteable_type: "MergeRequest",
      note: "/approve",
    },
    merge_request: { iid: mrIid },
  }
}

// ─── Helpers to build pre-bound runners ───────────────────────────────────────

function makePreBoundPhase1(
  gitlab: ReturnType<typeof makeFakeGitlab>,
  queue: ReturnType<typeof makeInMemoryQueue>,
) {
  const runClaude = vi.fn().mockResolvedValue({
    stdout: "## Impact Analysis\nAffects: UserService, AuthController\n",
  })
  const reviewSolution = vi.fn().mockResolvedValue({ verdict: "pass", notes: "" })
  const checkout = vi.fn().mockResolvedValue("/tmp/fake-be-checkout")
  const overlay = vi.fn().mockResolvedValue(undefined)
  const memorySearch = vi.fn().mockReturnValue([])
  const memoryWrite = vi.fn().mockReturnValue("mem-entry-1")

  const preBound = async (intent: ImpactJobIntent): Promise<{ mrIid: number }> => {
    const deps: Phase1Deps = {
      intent,
      registry: FAKE_REGISTRY,
      checkout,
      overlay,
      runClaude,
      reviewSolution,
      gitlab: {
        createDraftMR: gitlab.createDraftMR,
        commentMR: gitlab.commentMR,
        getMR: gitlab.getMR,
      },
      memory: { search: memorySearch, write: memoryWrite } as any,
      projectId: 1,
      controlPlaneDir: "/cp",
    }
    return runPhase1(deps)
  }

  return { preBound, runClaude, reviewSolution, checkout, overlay }
}

function makePreBoundPhase2(
  gitlab: ReturnType<typeof makeFakeGitlab>,
  queue: ReturnType<typeof makeInMemoryQueue>,
) {
  const runClaude = vi.fn().mockResolvedValue({
    stdout: 'implement footer\n{"pushed":true,"mr_iid":100,"affects_fe":false,"api_contract":"{}"}',
  })
  const checkout = vi.fn().mockResolvedValue("/tmp/fake-be-checkout-p2")
  const overlay = vi.fn().mockResolvedValue(undefined)
  const memoryWrite = vi.fn().mockReturnValue("mem-entry-2")

  const preBound = async (intent: Phase2JobIntent): Promise<void> => {
    const deps: Phase2Deps = {
      intent,
      registry: FAKE_REGISTRY,
      checkout,
      overlay,
      runClaude,
      gitlab: {
        finalizeMR: gitlab.finalizeMR,
        commentMR: gitlab.commentMR,
      },
      memory: { write: memoryWrite } as any,
      enqueuer: queue.enqueuer,
      projectId: 1,
      controlPlaneDir: "/cp",
    }
    return runPhase2(deps)
  }

  return { preBound, runClaude, checkout, overlay }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("e2e harness flow", () => {
  it("(a) push webhook → POST /webhook → impact job enqueued", async () => {
    const queue = makeInMemoryQueue()

    const server = buildServer({
      secret: "test-webhook-secret",
      classify,
      enqueuer: queue.enqueuer,
    })

    const res = await server.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "x-gitlab-token": "test-webhook-secret",
        "content-type": "application/json",
      },
      payload: PUSH_WEBHOOK,
    })

    expect(res.statusCode).toBe(200)
    expect(queue.jobs).toHaveLength(1)
    const job = queue.jobs[0]
    expect(job.type).toBe("impact")
    expect((job as ImpactJobIntent).target).toBe("be")
    expect((job as ImpactJobIntent).prd).toBe("PRD-1")
    expect((job as ImpactJobIntent).ref).toBe("feature/add-user-endpoint")
  })

  it("(b) processJob(impact) → phase1 runs → draft MR created in fake GitLab", async () => {
    const gitlab = makeFakeGitlab()
    const queue = makeInMemoryQueue()

    const { preBound: preBoundPhase1, runClaude, reviewSolution } = makePreBoundPhase1(gitlab, queue)
    const { preBound: preBoundPhase2 } = makePreBoundPhase2(gitlab, queue)

    const workerDeps: WorkerDeps = {
      isPaused: () => false,
      dryRun: false,
      runPhase1: preBoundPhase1,
      runPhase2: preBoundPhase2,
      gitlab: { commentMR: gitlab.commentMR },
      enqueuer: queue.enqueuer,
      projectId: 1,
    }

    const impactIntent: ImpactJobIntent = {
      type: "impact",
      target: "be",
      prd: "PRD-1",
      ref: "feature/add-user-endpoint",
    }

    await processJob(impactIntent, workerDeps)

    // runClaude was called for /auto-impact
    expect(runClaude).toHaveBeenCalledOnce()
    const claudeCall = (runClaude as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(claudeCall.command).toBe("/auto-impact")

    // reviewSolution was called with the claude output
    expect(reviewSolution).toHaveBeenCalledOnce()

    // A draft MR was created in fake GitLab
    expect(gitlab.createDraftMR).toHaveBeenCalledOnce()
    expect(gitlab.mrs.size).toBe(1)
    const mr = [...gitlab.mrs.values()][0]
    expect(mr.draft).toBe(true)
    expect(mr.title).toMatch(/Draft/)

    // dryRun=false: no "dry-run" comment posted
    const dryRunComment = mr.comments.find((c) => c.includes("dry-run"))
    expect(dryRunComment).toBeUndefined()
  })

  it("(c) /approve note webhook → enqueues approve; handleCommand → enqueues phase2", async () => {
    const gitlab = makeFakeGitlab()
    const queue = makeInMemoryQueue()
    const state = new InMemoryStateStore()

    // Seed the state so handleCommand can retrieve job details
    const mrIid = 100
    await state.putJob(String(mrIid), {
      target: "be",
      prd: "PRD-1",
      ref: "feature/add-user-endpoint",
      phase: "phase1",
      revisionCount: 0,
    })

    // Step 1: note webhook → server enqueues approve
    const server = buildServer({
      secret: "test-webhook-secret",
      classify,
      enqueuer: queue.enqueuer,
    })

    const res = await server.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "x-gitlab-token": "test-webhook-secret",
        "content-type": "application/json",
      },
      payload: makeApproveNoteWebhook(mrIid),
    })

    expect(res.statusCode).toBe(200)
    expect(queue.jobs).toHaveLength(1)
    expect(queue.jobs[0].type).toBe("approve")
    expect((queue.jobs[0] as { mrIid: number }).mrIid).toBe(mrIid)

    // Step 2: worker sees approve → defers to human-gate handler
    // (In production the worker calls handleCommand; simulate that here directly)
    const humanGateDeps: HumanGateDeps = {
      state,
      gitlab: {
        commentMR: gitlab.commentMR,
        setLabel: gitlab.setLabel,
      },
      enqueuer: queue.enqueuer,
      dryRun: false,
      projectId: 1,
    }

    const approveIntent = queue.jobs[0] as Extract<JobIntent, { mrIid: number }>
    await handleCommand(approveIntent, humanGateDeps)

    // handleCommand(approve, dryRun=false) → enqueues phase2
    // queue now has: [approve_job, phase2_job]
    expect(queue.jobs).toHaveLength(2)
    const phase2Job = queue.jobs[1]
    expect(phase2Job.type).toBe("phase2")
    expect((phase2Job as Phase2JobIntent).mrIid).toBe(mrIid)
    expect((phase2Job as Phase2JobIntent).target).toBe("be")
    expect((phase2Job as Phase2JobIntent).prd).toBe("PRD-1")

    // No comment posted for approve in live mode
    expect(gitlab.commentMR).not.toHaveBeenCalled()
  })

  it("(d) processJob(phase2) → runPhase2 → finalizeMR called", async () => {
    const gitlab = makeFakeGitlab()
    const queue = makeInMemoryQueue()

    // Pre-populate the MR in fake GitLab as draft (as Phase 1 would have left it)
    const mrIid = 100
    gitlab.mrs.set(mrIid, {
      iid: mrIid,
      title: "Draft: [be] PRD-1 impact analysis",
      body: "## Solution",
      draft: true,
      comments: [],
      labels: [],
    })

    const { preBound: preBoundPhase1 } = makePreBoundPhase1(gitlab, queue)
    const { preBound: preBoundPhase2, runClaude: claudeP2 } = makePreBoundPhase2(gitlab, queue)

    const workerDeps: WorkerDeps = {
      isPaused: () => false,
      dryRun: false,
      runPhase1: preBoundPhase1,
      runPhase2: preBoundPhase2,
      gitlab: { commentMR: gitlab.commentMR },
      enqueuer: queue.enqueuer,
      projectId: 1,
    }

    const phase2Intent: Phase2JobIntent = {
      type: "phase2",
      mrIid,
      target: "be",
      prd: "PRD-1",
      ref: "feature/add-user-endpoint",
    }

    await processJob(phase2Intent, workerDeps)

    // runClaude was called for /auto-implement
    expect(claudeP2).toHaveBeenCalledOnce()
    const claudeCall = (claudeP2 as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(claudeCall.command).toBe("/auto-implement")

    // finalizeMR called — MR is no longer draft
    expect(gitlab.finalizeMR).toHaveBeenCalledWith(1, mrIid)
    expect(gitlab.mrs.get(mrIid)?.draft).toBe(false)
  })

  it("full sequence: (a) → (b) → (c) → (d) call order verified", async () => {
    const callOrder: string[] = []
    const gitlab = makeFakeGitlab()
    const queue = makeInMemoryQueue()
    const state = new InMemoryStateStore()

    // Wrap fakes to record call order
    const origCreateDraftMR = gitlab.createDraftMR
    gitlab.createDraftMR = vi.fn(async (...args: Parameters<typeof origCreateDraftMR>) => {
      callOrder.push("createDraftMR")
      return origCreateDraftMR(...args)
    }) as typeof gitlab.createDraftMR

    const origFinalizeMR = gitlab.finalizeMR
    gitlab.finalizeMR = vi.fn(async (...args: Parameters<typeof origFinalizeMR>) => {
      callOrder.push("finalizeMR")
      return origFinalizeMR(...args)
    }) as typeof gitlab.finalizeMR

    // --- (a) push webhook ---
    const server = buildServer({
      secret: "test-webhook-secret",
      classify,
      enqueuer: queue.enqueuer,
    })

    await server.inject({
      method: "POST",
      url: "/webhook",
      headers: { "x-gitlab-token": "test-webhook-secret", "content-type": "application/json" },
      payload: PUSH_WEBHOOK,
    })
    callOrder.push("webhook:push:enqueued")

    // --- (b) worker processes impact ---
    const impactJob = queue.jobs[0] as ImpactJobIntent

    const { preBound: preBoundPhase1 } = makePreBoundPhase1(gitlab, queue)
    const { preBound: preBoundPhase2 } = makePreBoundPhase2(gitlab, queue)

    const workerDeps: WorkerDeps = {
      isPaused: () => false,
      dryRun: false,
      runPhase1: preBoundPhase1,
      runPhase2: preBoundPhase2,
      gitlab: { commentMR: gitlab.commentMR },
      enqueuer: queue.enqueuer,
      projectId: 1,
    }

    await processJob(impactJob, workerDeps)
    callOrder.push("processJob:impact:done")

    // Retrieve the created MR iid
    const mrIid = [...gitlab.mrs.values()][0].iid

    // Seed state for human-gate
    await state.putJob(String(mrIid), {
      target: "be",
      prd: "PRD-1",
      ref: "feature/add-user-endpoint",
      phase: "phase1",
      revisionCount: 0,
    })

    // --- (c) approve note webhook ---
    await server.inject({
      method: "POST",
      url: "/webhook",
      headers: { "x-gitlab-token": "test-webhook-secret", "content-type": "application/json" },
      payload: makeApproveNoteWebhook(mrIid),
    })
    callOrder.push("webhook:approve:enqueued")

    const approveJob = queue.jobs.find((j) => j.type === "approve") as Extract<JobIntent, { mrIid: number }>
    await handleCommand(approveJob, {
      state,
      gitlab: { commentMR: gitlab.commentMR, setLabel: gitlab.setLabel },
      enqueuer: queue.enqueuer,
      dryRun: false,
      projectId: 1,
    })
    callOrder.push("handleCommand:approve:done")

    // --- (d) worker processes phase2 ---
    const phase2Job = queue.jobs.find((j) => j.type === "phase2") as Phase2JobIntent
    await processJob(phase2Job, workerDeps)
    callOrder.push("processJob:phase2:done")

    // Assert call sequence
    expect(callOrder).toEqual([
      "webhook:push:enqueued",
      "createDraftMR",
      "processJob:impact:done",
      "webhook:approve:enqueued",
      "handleCommand:approve:done",
      "finalizeMR",
      "processJob:phase2:done",
    ])
  })
})
