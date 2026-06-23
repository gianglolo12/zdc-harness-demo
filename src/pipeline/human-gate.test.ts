import { describe, it, expect, vi } from "vitest"
import { handleCommand } from "./human-gate.js"
import type { HumanGateDeps } from "./human-gate.js"
import type { JobIntent } from "../classifier.js"

// ─── Shared fakes ─────────────────────────────────────────────────────────────

function makeState(initialRevision = 0) {
  let revision = initialRevision
  const jobs = new Map<string, { target: string; prd: string; ref: string; phase: string; revisionCount: number }>()

  // Seed a default job for mrIid "7"
  jobs.set("7", { target: "be", prd: "PRD-42", ref: "feature/x", phase: "phase1", revisionCount: initialRevision })

  return {
    putJob: vi.fn().mockResolvedValue(undefined),
    getJob: vi.fn().mockImplementation(async (mrIid: string) => jobs.get(mrIid)),
    incRevision: vi.fn().mockImplementation(async (_mrIid: string) => {
      revision += 1
      return revision
    }),
  }
}

function makeDeps(overrides: Partial<HumanGateDeps> = {}): HumanGateDeps {
  return {
    state: makeState(),
    gitlab: {
      commentMR: vi.fn().mockResolvedValue(undefined),
      setLabel: vi.fn().mockResolvedValue(undefined),
    },
    enqueuer: {
      enqueue: vi.fn().mockResolvedValue(undefined),
    },
    dryRun: false,
    projectId: 42,
    ...overrides,
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("handleCommand — revise", () => {
  it("revise 1st time (<3) → incRevision + enqueue phase1 impact, no setLabel", async () => {
    const deps = makeDeps({ state: makeState(0) }) // starts at 0, after inc → 1
    const intent: JobIntent = { type: "revise", mrIid: 7, feedback: "use cache" }

    await handleCommand(intent, deps)

    expect(deps.state.incRevision).toHaveBeenCalledWith("7")
    expect(deps.enqueuer.enqueue).toHaveBeenCalledOnce()
    // Enqueued job must be an impact intent carrying feedback
    const enqueuedJob = (deps.enqueuer.enqueue as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(enqueuedJob.type).toBe("impact")
    expect(enqueuedJob.feedback).toBe("use cache")
    expect(deps.gitlab.setLabel).not.toHaveBeenCalled()
  })

  it("revise 4th time (≥3) → setLabel needs-human + commentMR, no enqueue", async () => {
    // starts at 3, after inc → 4 which is >=3
    const state = makeState(3)
    const deps = makeDeps({ state })
    const intent: JobIntent = { type: "revise", mrIid: 7, feedback: "still wrong" }

    await handleCommand(intent, deps)

    expect(state.incRevision).toHaveBeenCalledWith("7")
    expect(deps.gitlab.setLabel).toHaveBeenCalledWith(42, 7, "needs-human")
    expect(deps.gitlab.commentMR).toHaveBeenCalledOnce()
    const commentBody = (deps.gitlab.commentMR as ReturnType<typeof vi.fn>).mock.calls[0][2] as string
    expect(commentBody).toMatch(/needs-human/)
    expect(deps.enqueuer.enqueue).not.toHaveBeenCalled()
  })

  it("revise 3rd time (exactly ≥3) → setLabel needs-human, no enqueue", async () => {
    // starts at 2, after inc → 3 which hits the cap
    const state = makeState(2)
    const deps = makeDeps({ state })
    const intent: JobIntent = { type: "revise", mrIid: 7, feedback: "" }

    await handleCommand(intent, deps)

    expect(deps.gitlab.setLabel).toHaveBeenCalledWith(42, 7, "needs-human")
    expect(deps.enqueuer.enqueue).not.toHaveBeenCalled()
  })
})

describe("handleCommand — approve", () => {
  it("approve + dryRun=false → enqueue phase2 job", async () => {
    const deps = makeDeps({ dryRun: false })
    const intent: JobIntent = { type: "approve", mrIid: 7 }

    await handleCommand(intent, deps)

    expect(deps.enqueuer.enqueue).toHaveBeenCalledOnce()
    const enqueuedJob = (deps.enqueuer.enqueue as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(enqueuedJob.type).toBe("phase2")
    expect(enqueuedJob.mrIid).toBe(7)
    expect(deps.gitlab.commentMR).not.toHaveBeenCalled()
  })

  it("approve + dryRun=true → no enqueue + commentMR with dry-run message", async () => {
    const deps = makeDeps({ dryRun: true })
    const intent: JobIntent = { type: "approve", mrIid: 7 }

    await handleCommand(intent, deps)

    expect(deps.enqueuer.enqueue).not.toHaveBeenCalled()
    expect(deps.gitlab.commentMR).toHaveBeenCalledOnce()
    const commentBody = (deps.gitlab.commentMR as ReturnType<typeof vi.fn>).mock.calls[0][2] as string
    expect(commentBody).toMatch(/dry-run/)
  })
})

describe("handleCommand — reject / abort", () => {
  it("reject → commentMR (mark done), no enqueue", async () => {
    const deps = makeDeps()
    const intent: JobIntent = { type: "reject", mrIid: 7 }

    await handleCommand(intent, deps)

    expect(deps.enqueuer.enqueue).not.toHaveBeenCalled()
    expect(deps.gitlab.commentMR).toHaveBeenCalledOnce()
    const commentBody = (deps.gitlab.commentMR as ReturnType<typeof vi.fn>).mock.calls[0][2] as string
    expect(commentBody).toMatch(/reject/)
  })

  it("abort → commentMR (mark done), no enqueue", async () => {
    const deps = makeDeps()
    const intent: JobIntent = { type: "abort", mrIid: 7 }

    await handleCommand(intent, deps)

    expect(deps.enqueuer.enqueue).not.toHaveBeenCalled()
    expect(deps.gitlab.commentMR).toHaveBeenCalledOnce()
    const commentBody = (deps.gitlab.commentMR as ReturnType<typeof vi.fn>).mock.calls[0][2] as string
    expect(commentBody).toMatch(/abort/)
  })
})
