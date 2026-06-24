import { describe, it, expect, vi, beforeEach } from "vitest"
import { runPhase1 } from "./phase1-impact.js"
import type { Phase1Deps } from "./phase1-impact.js"

// ─── Shared fakes ─────────────────────────────────────────────────────────────

const fakeEntry = { sourceRepo: "git@gl:zdc/be-source.git", bundle: "be", controlPlaneRef: "main" }

function makeFakeState() {
  const store = new Map<string, unknown>()
  return {
    putJob: vi.fn(async (mrIid: string, job: unknown) => { store.set(mrIid, job) }),
    _store: store,
  }
}

function makeDeps(overrides: Partial<Phase1Deps> = {}): Phase1Deps {
  return {
    intent: { type: "impact", target: "be", prd: "PRD-42", ref: "feature/x" },
    registry: { repos: { be: fakeEntry } },
    checkout: vi.fn().mockResolvedValue("/tmp/checkout-be"),
    prepareBranch: vi.fn(async () => {}),
    overlay: vi.fn().mockResolvedValue(undefined),
    overlayPrdDocs: vi.fn(async () => {}),
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
    state: makeFakeState(),
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
      expect.objectContaining({ sourceRepo: fakeEntry.sourceRepo, ref: "zdc-be-prd-42" }),
    )
  })

  // ─── C1: state.putJob persisted after MR creation ───────────────────────────

  it("C1: state.putJob is called with mrIid and correct job fields after createDraftMR", async () => {
    const state = makeFakeState()
    const deps = makeDeps({ state })
    await runPhase1(deps)
    expect(state.putJob).toHaveBeenCalledOnce()
    expect(state.putJob).toHaveBeenCalledWith("99", {
      target: "be",
      prd: "PRD-42",
      ref: "zdc-be-prd-42",
      phase: "phase1",
      revisionCount: 0,
      dispatchIssue: undefined,
    })
  })

  it("C1: state.putJob mrIid matches the iid returned by createDraftMR", async () => {
    const state = makeFakeState()
    const gitlab = {
      createDraftMR: vi.fn().mockResolvedValue({ iid: 77 }),
      commentMR: vi.fn(),
      getMR: vi.fn(),
    } as any
    const deps = makeDeps({ state, gitlab })
    const result = await runPhase1(deps)
    expect(result.mrIid).toBe(77)
    expect(state.putJob).toHaveBeenCalledWith("77", expect.objectContaining({ target: "be" }))
  })

  // ─── I1: feedback reaches /auto-impact input ─────────────────────────────────

  it("I1: feedback from intent is included in /auto-impact input", async () => {
    const deps = makeDeps({
      intent: { type: "impact", target: "be", prd: "PRD-42", ref: "feature/x", feedback: "please add caching" },
    })
    await runPhase1(deps)
    const firstCall = (deps.runClaude as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(firstCall[0].input).toContain("please add caching")
  })

  it("I1: feedback is absent from input when not provided", async () => {
    const deps = makeDeps()
    await runPhase1(deps)
    const firstCall = (deps.runClaude as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(firstCall[0].input).not.toContain("Human feedback")
  })

  // ─── I2: api_contract reaches /auto-impact input ─────────────────────────────

  it("I2: api_contract from intent is included in /auto-impact input", async () => {
    const deps = makeDeps({
      intent: { type: "impact", target: "fe", prd: "PRD-42", ref: "main", api_contract: '{"POST /users":"..."}' },
      registry: { repos: { fe: fakeEntry } },
    })
    await runPhase1(deps)
    const firstCall = (deps.runClaude as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(firstCall[0].input).toContain('{"POST /users":"..."}')
  })

  it("I2: api_contract is absent from input when not provided", async () => {
    const deps = makeDeps()
    await runPhase1(deps)
    const firstCall = (deps.runClaude as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(firstCall[0].input).not.toContain("API contract")
  })
})
