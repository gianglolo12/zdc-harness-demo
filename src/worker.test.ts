import { describe, it, expect, vi } from "vitest"
import { processJob, selectGitClient } from "./worker.js"
import type { JobIntent, ImpactJobIntent } from "./classifier.js"
import type { Phase2JobIntent } from "./pipeline/human-gate.js"

// ─── Shared fakes ─────────────────────────────────────────────────────────────

const impactIntent: JobIntent = { type: "impact", target: "be", prd: "my-prd", ref: "feature-x" }
const phase2Intent: Phase2JobIntent = { type: "phase2", mrIid: 42, target: "be", prd: "my-prd", ref: "feature-x" }

function makePhase1Deps(overrides?: Partial<Parameters<typeof processJob>[1]>) {
  const runPhase1 = vi.fn<(intent: ImpactJobIntent) => Promise<{ mrIid: number }>>().mockResolvedValue({ mrIid: 99 })
  const runPhase2 = vi.fn<(intent: Phase2JobIntent) => Promise<void>>().mockResolvedValue(undefined)
  const handleCommand = vi.fn<(intent: Extract<JobIntent, { mrIid: number }>) => Promise<void>>().mockResolvedValue(undefined)
  const commentMR = vi.fn().mockResolvedValue(undefined)
  const enqueue = vi.fn().mockResolvedValue(undefined)
  const ackDispatch = vi.fn<(issueNumber: number, body: string) => Promise<void>>().mockResolvedValue(undefined)
  const handleMerged = vi.fn<(mrIid: number) => Promise<void>>().mockResolvedValue(undefined)

  const deps = {
    isPaused: () => false,
    dryRun: false,
    runPhase1,
    runPhase2,
    handleCommand,
    gitlab: { commentMR },
    ackDispatch,
    handleMerged,
    enqueuer: { enqueue },
    projectId: 1,
    ...overrides,
  }

  return { deps, runPhase1, runPhase2, handleCommand, commentMR, enqueue, ackDispatch, handleMerged }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("processJob", () => {
  it("paused → phase1 NOT called", async () => {
    const { deps, runPhase1 } = makePhase1Deps({ isPaused: () => true })

    await processJob(impactIntent, deps)

    expect(runPhase1).not.toHaveBeenCalled()
  })

  it("impact + dryRun=false → phase1 called, commentMR NOT called for dry-run, no phase2 enqueue here", async () => {
    const { deps, runPhase1, commentMR } = makePhase1Deps({ dryRun: false })

    await processJob(impactIntent, deps)

    expect(runPhase1).toHaveBeenCalledOnce()
    // dry-run comment should NOT be posted
    expect(commentMR).not.toHaveBeenCalled()
  })

  it("impact + dryRun=true → phase1 called, commentMR called with dry-run message, enqueue NOT called for phase2", async () => {
    const { deps, runPhase1, commentMR, enqueue } = makePhase1Deps({ dryRun: true })

    await processJob(impactIntent, deps)

    expect(runPhase1).toHaveBeenCalledOnce()
    // dry-run comment must be posted
    expect(commentMR).toHaveBeenCalledOnce()
    const [, , body] = commentMR.mock.calls[0] as [number, number, string]
    expect(body).toMatch(/dry-run/)
    // phase2 must NOT be enqueued
    expect(enqueue).not.toHaveBeenCalled()
  })

  it("approve intent + not paused → handleCommand called, runPhase1 NOT called, runPhase2 NOT called", async () => {
    const { deps, runPhase1, runPhase2, handleCommand } = makePhase1Deps()
    const approveIntent: JobIntent = { type: "approve", mrIid: 5 }

    await processJob(approveIntent, deps)

    expect(handleCommand).toHaveBeenCalledOnce()
    expect(handleCommand).toHaveBeenCalledWith(approveIntent)
    expect(runPhase1).not.toHaveBeenCalled()
    expect(runPhase2).not.toHaveBeenCalled()
  })

  it("approve intent + paused → handleCommand NOT called (kill-switch wins)", async () => {
    const { deps, handleCommand } = makePhase1Deps({ isPaused: () => true })
    const approveIntent: JobIntent = { type: "approve", mrIid: 5 }

    await processJob(approveIntent, deps)

    expect(handleCommand).not.toHaveBeenCalled()
  })

  it("phase2 intent → runPhase2 called, runPhase1 NOT called", async () => {
    const { deps, runPhase1, runPhase2 } = makePhase1Deps()

    await processJob(phase2Intent as unknown as JobIntent, deps)

    expect(runPhase2).toHaveBeenCalledOnce()
    expect(runPhase2).toHaveBeenCalledWith(phase2Intent)
    expect(runPhase1).not.toHaveBeenCalled()
  })

  it("phase2 intent + paused → runPhase2 NOT called", async () => {
    const { deps, runPhase2 } = makePhase1Deps({ isPaused: () => true })

    await processJob(phase2Intent as unknown as JobIntent, deps)

    expect(runPhase2).not.toHaveBeenCalled()
  })

  it("impact carrying dispatchIssue → ackDispatch called before phase1", async () => {
    const { deps, ackDispatch, runPhase1 } = makePhase1Deps()
    const dispatchIntent: JobIntent = { type: "impact", target: "be", prd: "G3-F07", ref: "issue-7", dispatchIssue: 7 }

    await processJob(dispatchIntent, deps)

    expect(ackDispatch).toHaveBeenCalledOnce()
    const [issueNumber] = ackDispatch.mock.calls[0] as [number, string]
    expect(issueNumber).toBe(7)
    expect(runPhase1).toHaveBeenCalledOnce()
  })

  it("impact without dispatchIssue → ackDispatch NOT called", async () => {
    const { deps, ackDispatch } = makePhase1Deps()

    await processJob(impactIntent, deps)

    expect(ackDispatch).not.toHaveBeenCalled()
  })

  it("ackDispatch failure does not abort the job (phase1 still runs)", async () => {
    const { deps, runPhase1 } = makePhase1Deps({
      ackDispatch: vi.fn().mockRejectedValue(new Error("comment failed")),
    })
    const dispatchIntent: JobIntent = { type: "impact", target: "be", prd: "G3-F07", ref: "issue-7", dispatchIssue: 7 }

    await processJob(dispatchIntent, deps)

    expect(runPhase1).toHaveBeenCalledOnce()
  })

  it("merged intent → handleMerged called, runPhase1 NOT called", async () => {
    const { deps, handleMerged, runPhase1 } = makePhase1Deps()
    const mergedIntent: JobIntent = { type: "merged", mrIid: 88 }

    await processJob(mergedIntent, deps)

    expect(handleMerged).toHaveBeenCalledOnce()
    expect(handleMerged).toHaveBeenCalledWith(88)
    expect(runPhase1).not.toHaveBeenCalled()
  })

  it("merged intent + paused → handleMerged NOT called", async () => {
    const { deps, handleMerged } = makePhase1Deps({ isPaused: () => true })
    const mergedIntent: JobIntent = { type: "merged", mrIid: 88 }

    await processJob(mergedIntent, deps)

    expect(handleMerged).not.toHaveBeenCalled()
  })
})

// ─── Provider selection ───────────────────────────────────────────────────────

describe("selectGitClient", () => {
  it("gitlab config → returns GitLabClient instance", () => {
    const { client, kind } = selectGitClient({
      gitProvider: "gitlab",
      gitlabToken: "tok",
      gitlabUrl: "https://gitlab.example.com",
      webhookSecret: "s",
      redisUrl: "redis://localhost:6379",
      dryRun: false,
    })
    expect(kind).toBe("gitlab")
    expect(client).toBeDefined()
  })

  it("github config → returns GitHubClient instance", () => {
    const { client, kind } = selectGitClient({
      gitProvider: "github",
      github: { token: "ghp_tok", owner: "my-org", repo: "my-repo" },
      webhookSecret: "s",
      redisUrl: "redis://localhost:6379",
      dryRun: false,
    })
    expect(kind).toBe("github")
    expect(client).toBeDefined()
  })
})
