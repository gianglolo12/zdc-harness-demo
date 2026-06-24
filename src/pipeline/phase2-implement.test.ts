import { describe, it, expect, vi } from "vitest"
import { runPhase2 } from "./phase2-implement.js"
import type { Phase2Deps } from "./phase2-implement.js"

// ─── Shared fakes ─────────────────────────────────────────────────────────────

function makeDeps(overrides: Partial<Phase2Deps> = {}): Phase2Deps {
  const checkout = vi.fn().mockResolvedValue("/tmp/fake-checkout")
  const overlay = vi.fn().mockResolvedValue(undefined)
  const finalizeMR = vi.fn().mockResolvedValue(undefined)
  const commentMR = vi.fn().mockResolvedValue(undefined)
  const memoryWrite = vi.fn().mockReturnValue("new-entry-id")
  const enqueue = vi.fn().mockResolvedValue(undefined)

  // Default runClaude returns affects_fe:false
  const runClaude = vi
    .fn()
    .mockResolvedValue({
      stdout: 'Some output\n{"pushed":true,"mr_iid":42,"affects_fe":false,"api_contract":"{}"}',
    })

  const deps: Phase2Deps = {
    intent: { type: "phase2", mrIid: 42, target: "be", prd: "my-prd", ref: "feature-x" },
    registry: {
      repos: {
        be: { sourceRepo: "git@gitlab.com/org/be.git", bundle: "be", controlPlaneRef: "main" },
        fe: { sourceRepo: "git@gitlab.com/org/fe.git", bundle: "fe", controlPlaneRef: "main" },
      },
    },
    checkout,
    overlay,
    runClaude,
    gitlab: { finalizeMR, commentMR },
    memory: { write: memoryWrite },
    enqueuer: { enqueue },
    projectId: 1,
    controlPlaneDir: "/cp",
    ...overrides,
  }

  return deps
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("runPhase2", () => {
  it("calls checkout + overlay + runClaude", async () => {
    const deps = makeDeps()

    await runPhase2(deps)

    expect(deps.checkout).toHaveBeenCalledOnce()
    expect(deps.overlay).toHaveBeenCalledOnce()
    expect(deps.runClaude).toHaveBeenCalledOnce()
    const callArg = (deps.runClaude as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(callArg.command).toBe("/auto-implement")
  })

  it("calls gitlab.finalizeMR with projectId + mrIid", async () => {
    const deps = makeDeps()

    await runPhase2(deps)

    expect(deps.gitlab.finalizeMR).toHaveBeenCalledWith(1, 42)
  })

  it("calls memory.write with a lesson entry", async () => {
    const deps = makeDeps()

    await runPhase2(deps)

    expect(deps.memory.write).toHaveBeenCalledOnce()
    const entry = (deps.memory.write as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(entry).toMatchObject({
      repo: expect.any(String),
      area: expect.any(String),
      issue: expect.any(String),
      rootCause: expect.any(String),
      fix: expect.any(String),
      tags: expect.arrayContaining(["phase2"]),
    })
  })

  it("affects_fe:false → enqueuer.enqueue NOT called", async () => {
    const deps = makeDeps()

    await runPhase2(deps)

    expect(deps.enqueuer.enqueue).not.toHaveBeenCalled()
  })

  it("affects_fe:true + target=be → enqueuer.enqueue called with fe impact job", async () => {
    const deps = makeDeps({
      runClaude: vi
        .fn()
        .mockResolvedValue({
          stdout:
            'work done\n{"pushed":true,"mr_iid":42,"affects_fe":true,"api_contract":"{\\"endpoint\\":\\"/api/v2\\"}"}',
        }),
    })

    await runPhase2(deps)

    expect(deps.enqueuer.enqueue).toHaveBeenCalledOnce()
    const job = (deps.enqueuer.enqueue as ReturnType<typeof vi.fn>).mock.calls[0][0]
    // I3: FE handoff uses "main" (not the BE branch "feature-x") so FE repo clone succeeds
    expect(job).toMatchObject({
      type: "impact",
      target: "fe",
      prd: "my-prd",
      ref: "main",
    })
    // I2: api_contract from footer reaches the enqueued FE impact job
    expect(job.api_contract).toBeDefined()
    expect(job.api_contract).toContain("/api/v2")
  })

  it("affects_fe:true but target=fe → enqueuer.enqueue NOT called (avoid loop)", async () => {
    const deps = makeDeps({
      intent: { type: "phase2", mrIid: 42, target: "fe", prd: "my-prd", ref: "feature-x" },
      registry: { repos: { fe: { sourceRepo: "git@gitlab.com/org/fe.git", bundle: "fe", controlPlaneRef: "main" } } },
      runClaude: vi
        .fn()
        .mockResolvedValue({
          stdout: '{"pushed":true,"mr_iid":42,"affects_fe":true,"api_contract":"{}"}',
        }),
    })

    await runPhase2(deps)

    expect(deps.enqueuer.enqueue).not.toHaveBeenCalled()
  })

  it("throws if registry has no entry for target", async () => {
    const deps = makeDeps({
      registry: { repos: {} },
    })

    await expect(runPhase2(deps)).rejects.toThrow(/Registry/)
  })

  it("affects_fe:true + target=be + no fe registry entry → enqueuer NOT called, no throw", async () => {
    const deps = makeDeps({
      // Registry only has "be", no "fe" entry
      registry: { repos: { be: { sourceRepo: "git@gitlab.com/org/be.git", bundle: "be", controlPlaneRef: "main" } } },
      runClaude: vi
        .fn()
        .mockResolvedValue({
          stdout:
            'work done\n{"pushed":true,"mr_iid":42,"affects_fe":true,"api_contract":"{\\"endpoint\\":\\"/api/v2\\"}"}',
        }),
    })

    await expect(runPhase2(deps)).resolves.not.toThrow()
    expect(deps.enqueuer.enqueue).not.toHaveBeenCalled()
  })

  it("handles stdout without JSON footer gracefully (no crash)", async () => {
    const deps = makeDeps({
      runClaude: vi.fn().mockResolvedValue({ stdout: "plain output, no json footer" }),
    })

    await runPhase2(deps)

    expect(deps.gitlab.finalizeMR).toHaveBeenCalledOnce()
    expect(deps.memory.write).toHaveBeenCalledOnce()
    expect(deps.enqueuer.enqueue).not.toHaveBeenCalled()
  })
})
