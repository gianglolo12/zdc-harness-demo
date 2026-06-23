import { describe, it, expect, vi } from "vitest"
import { reviewSolution } from "./second-opinion.js"
import type { ClaudeRunnerOpts } from "../claude-runner.js"

describe("reviewSolution", () => {
  it("returns fail verdict with notes when runClaude returns fail JSON", async () => {
    const fakeRunClaude = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ verdict: "fail", notes: "missing edge case X" }),
    })

    const result = await reviewSolution({
      cwd: "/tmp/test",
      solution: "some solution text",
      runClaude: fakeRunClaude,
    })

    expect(result.verdict).toBe("fail")
    expect(result.notes).toBe("missing edge case X")
    expect(fakeRunClaude).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/tmp/test",
        command: "/auto-review-solution",
        input: "some solution text",
      }),
    )
  })

  it("returns pass verdict with notes when runClaude returns pass JSON", async () => {
    const fakeRunClaude = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ verdict: "pass", notes: "looks good" }),
    })

    const result = await reviewSolution({
      cwd: "/tmp/test",
      solution: "some solution text",
      runClaude: fakeRunClaude,
    })

    expect(result.verdict).toBe("pass")
    expect(result.notes).toBe("looks good")
  })

  it("returns fail with default notes when runClaude returns garbage (unparseable)", async () => {
    const fakeRunClaude = vi.fn().mockResolvedValue({
      stdout: "not valid json at all!!!",
    })

    const result = await reviewSolution({
      cwd: "/tmp/test",
      solution: "some solution text",
      runClaude: fakeRunClaude,
    })

    expect(result.verdict).toBe("fail")
    expect(result.notes).toBe("unparseable review output")
  })
})
