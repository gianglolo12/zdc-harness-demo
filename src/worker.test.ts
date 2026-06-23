import { describe, it, expect, vi } from "vitest"
import { processJob } from "./worker.js"
import type { JobIntent, ImpactJobIntent } from "./classifier.js"
import type { Phase2JobIntent } from "./pipeline/human-gate.js"

// ─── Shared fakes ─────────────────────────────────────────────────────────────

const impactIntent: JobIntent = { type: "impact", target: "be", prd: "my-prd", ref: "feature-x" }
const phase2Intent: Phase2JobIntent = { type: "phase2", mrIid: 42, target: "be", prd: "my-prd", ref: "feature-x" }

function makePhase1Deps(overrides?: Partial<Parameters<typeof processJob>[1]>) {
  const runPhase1 = vi.fn<[ImpactJobIntent], Promise<{ mrIid: number }>>().mockResolvedValue({ mrIid: 99 })
  const runPhase2 = vi.fn<[Phase2JobIntent], Promise<void>>().mockResolvedValue(undefined)
  const commentMR = vi.fn().mockResolvedValue(undefined)
  const enqueue = vi.fn().mockResolvedValue(undefined)

  const deps = {
    isPaused: () => false,
    dryRun: false,
    runPhase1,
    runPhase2,
    gitlab: { commentMR },
    enqueuer: { enqueue },
    projectId: 1,
    ...overrides,
  }

  return { deps, runPhase1, runPhase2, commentMR, enqueue }
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

  it("non-impact intent (approve) + not paused → phase1 NOT called (handled by future task)", async () => {
    const { deps, runPhase1 } = makePhase1Deps()
    const approveIntent: JobIntent = { type: "approve", mrIid: 5 }

    await processJob(approveIntent, deps)

    // Task 12 only handles impact; others are no-ops here
    expect(runPhase1).not.toHaveBeenCalled()
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
})
