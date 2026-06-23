import { describe, it, expect, vi, beforeEach } from "vitest"
import { runPhase1 } from "./phase1-impact.js"
import type { Phase1Deps } from "./phase1-impact.js"

// ─── Shared fakes ─────────────────────────────────────────────────────────────

const fakeEntry = { sourceRepo: "git@gl:zdc/be-source.git", bundle: "be", controlPlaneRef: "main" }

function makeDeps(overrides: Partial<Phase1Deps> = {}): Phase1Deps {
  return {
    intent: { type: "impact", target: "be", prd: "PRD-42", ref: "feature/x" },
    registry: { repos: { be: fakeEntry } },
    checkout: vi.fn().mockResolvedValue("/tmp/checkout-be"),
    overlay: vi.fn().mockResolvedValue(undefined),
    runClaude: vi.fn().mockResolvedValue({ stdout: "## Solution\nDo the thing." }),
    reviewSolution: vi.fn().mockResolvedValue({ verdict: "pass", notes: "" }),
    gitlab: {
      createDraftMR: vi.fn().mockResolvedValue({ iid: 99 }),
      commentMR: vi.fn(),
      getMR: vi.fn(),
    } as any,
    memory: {
      search: vi.fn().mockReturnValue([
        { id: "m1", repo: "be", area: "payment", fix: "add retry", issue: "timeout", rootCause: "no retry", errorSignature: "ESP", tags: [], created: "" },
      ]),
    } as any,
    projectId: 7,
    controlPlaneDir: "/cp",
    ...overrides,
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("runPhase1", () => {
  it("returns mrIid from gitlab.createDraftMR", async () => {
    const deps = makeDeps()
    const result = await runPhase1(deps)
    expect(result.mrIid).toBe(99)
  })

  it("overlay is called before runClaude", async () => {
    const callOrder: string[] = []
    const deps = makeDeps({
      overlay: vi.fn().mockImplementation(async () => { callOrder.push("overlay") }),
      runClaude: vi.fn().mockImplementation(async () => { callOrder.push("runClaude"); return { stdout: "sol" } }),
    })
    await runPhase1(deps)
    const overlayIdx = callOrder.indexOf("overlay")
    const claudeIdx = callOrder.indexOf("runClaude")
    expect(overlayIdx).toBeGreaterThanOrEqual(0)
    expect(claudeIdx).toBeGreaterThan(overlayIdx)
  })

  it("when reviewSolution fails once then passes, runClaude /auto-impact is invoked twice", async () => {
    const deps = makeDeps({
      reviewSolution: vi
        .fn()
        .mockResolvedValueOnce({ verdict: "fail", notes: "missing edge case" })
        .mockResolvedValueOnce({ verdict: "pass", notes: "" }),
    })
    await runPhase1(deps)
    // runClaude is called for /auto-impact twice (initial + retry)
    const autoImpactCalls = (deps.runClaude as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: any[]) => (args[0] as any).command === "/auto-impact",
    )
    expect(autoImpactCalls).toHaveLength(2)
  })

  it("retry /auto-impact includes review notes in input", async () => {
    const deps = makeDeps({
      reviewSolution: vi
        .fn()
        .mockResolvedValueOnce({ verdict: "fail", notes: "needs cache" })
        .mockResolvedValueOnce({ verdict: "pass", notes: "" }),
    })
    await runPhase1(deps)
    const calls = (deps.runClaude as ReturnType<typeof vi.fn>).mock.calls
    const retryCall = calls[1]
    expect(retryCall[0].input).toContain("needs cache")
  })

  it("createDraftMR receives the final solution body", async () => {
    const deps = makeDeps({
      runClaude: vi
        .fn()
        .mockResolvedValueOnce({ stdout: "First solution" })
        .mockResolvedValueOnce({ stdout: "Refined solution" }),
      reviewSolution: vi
        .fn()
        .mockResolvedValueOnce({ verdict: "fail", notes: "fix it" })
        .mockResolvedValueOnce({ verdict: "pass", notes: "" }),
    })
    await runPhase1(deps)
    const body = (deps.gitlab.createDraftMR as ReturnType<typeof vi.fn>).mock.calls[0][3] as string
    expect(body).toContain("Refined solution")
  })

  it("MR body includes memory_refs", async () => {
    const deps = makeDeps()
    await runPhase1(deps)
    const body = (deps.gitlab.createDraftMR as ReturnType<typeof vi.fn>).mock.calls[0][3] as string
    expect(body).toContain("memory_refs")
  })

  it("stops after 2 attempts even if both reviews fail", async () => {
    const deps = makeDeps({
      reviewSolution: vi.fn().mockResolvedValue({ verdict: "fail", notes: "still bad" }),
    })
    await runPhase1(deps)
    const autoImpactCalls = (deps.runClaude as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: any[]) => (args[0] as any).command === "/auto-impact",
    )
    expect(autoImpactCalls).toHaveLength(2)
  })

  it("checkout is called with sourceRepo and ref", async () => {
    const deps = makeDeps()
    await runPhase1(deps)
    expect(deps.checkout).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRepo: fakeEntry.sourceRepo, ref: "feature/x" }),
    )
  })
})
