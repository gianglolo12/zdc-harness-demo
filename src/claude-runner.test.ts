import { describe, it, expect, vi } from "vitest"
import { runClaude } from "./claude-runner.js"

describe("runClaude", () => {
  it("calls runner with cwd and args containing -p and command", async () => {
    const fake = vi.fn().mockResolvedValue({ stdout: "OK" })
    const r = await runClaude({ cwd: "/x", command: "/auto-impact", runner: fake })
    expect(fake).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/x" }),
      expect.arrayContaining(["-p", "/auto-impact"]),
    )
    expect(r.stdout).toBe("OK")
  })

  it("passes input to runner when provided", async () => {
    const fake = vi.fn().mockResolvedValue({ stdout: "result" })
    await runClaude({ cwd: "/y", command: "/cmd", input: "my-input", runner: fake })
    expect(fake).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/y", input: "my-input" }),
      expect.any(Array),
    )
  })

  it("parses tokensIn and tokensOut from JSON footer in stdout", async () => {
    const footer = JSON.stringify({ tokensIn: 100, tokensOut: 200 })
    const stdout = `some output\n${footer}`
    const fake = vi.fn().mockResolvedValue({ stdout })
    const r = await runClaude({ cwd: "/z", command: "/cmd", runner: fake })
    expect(r.stdout).toBe(stdout)
    expect(r.tokensIn).toBe(100)
    expect(r.tokensOut).toBe(200)
  })

  it("returns no token fields when footer is absent", async () => {
    const fake = vi.fn().mockResolvedValue({ stdout: "plain output" })
    const r = await runClaude({ cwd: "/z", command: "/cmd", runner: fake })
    expect(r.tokensIn).toBeUndefined()
    expect(r.tokensOut).toBeUndefined()
  })

  it("builds args as [--dangerously-skip-permissions, -p, command]", async () => {
    const fake = vi.fn().mockResolvedValue({ stdout: "" })
    await runClaude({ cwd: "/a", command: "/my-command", runner: fake })
    const [, args] = fake.mock.calls[0] as [unknown, string[]]
    expect(args).toEqual(["--dangerously-skip-permissions", "-p", "/my-command"])
  })
})
