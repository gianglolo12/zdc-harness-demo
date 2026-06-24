import { describe, it, expect, vi } from "vitest"
import { runClaude, parseStreamJson } from "./claude-runner.js"

// Build a stream-json JSONL transcript from parts.
function jsonl(...events: unknown[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n")
}

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

  it("parses tokensIn and tokensOut from JSON footer in stdout (legacy plain)", async () => {
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

  it("builds args with stream-json/verbose plus skip-permissions and -p command", async () => {
    const fake = vi.fn().mockResolvedValue({ stdout: "" })
    await runClaude({ cwd: "/a", command: "/my-command", runner: fake })
    const [, args] = fake.mock.calls[0] as [unknown, string[]]
    expect(args).toEqual([
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "--verbose",
      "-p",
      "/my-command",
    ])
  })

  it("extracts result text from stream-json as stdout (footer-parse still works on it)", async () => {
    const footer = JSON.stringify({ pushed: true })
    const stream = jsonl(
      { type: "assistant", message: { content: [{ type: "text", text: "thinking" }] } },
      { type: "result", result: `done\n${footer}`, usage: { input_tokens: 5, output_tokens: 9 } },
    )
    const fake = vi.fn().mockResolvedValue({ stdout: stream })
    const r = await runClaude({ cwd: "/a", command: "/cmd", runner: fake })
    expect(r.stdout).toBe(`done\n${footer}`)
    expect(r.tokensIn).toBe(5)
    expect(r.tokensOut).toBe(9)
  })

  it("invokes onActivity once per tool_use", async () => {
    const stream = jsonl(
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Edit", input: { file_path: "src/x.ts" } },
            { type: "tool_use", name: "Bash", input: { command: "npm test" } },
          ],
        },
      },
      { type: "result", result: "ok" },
    )
    const fake = vi.fn().mockResolvedValue({ stdout: stream })
    const activities: string[] = []
    const r = await runClaude({
      cwd: "/a",
      command: "/cmd",
      runner: fake,
      onActivity: (t) => activities.push(t),
    })
    expect(activities).toEqual(["Edit src/x.ts", "Bash npm test"])
    expect(r.stdout).toBe("ok")
  })

  it("does not throw when onActivity callback throws", async () => {
    const stream = jsonl(
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: {} }] } },
      { type: "result", result: "ok" },
    )
    const fake = vi.fn().mockResolvedValue({ stdout: stream })
    await expect(
      runClaude({
        cwd: "/a",
        command: "/cmd",
        runner: fake,
        onActivity: () => {
          throw new Error("boom")
        },
      }),
    ).resolves.toMatchObject({ stdout: "ok" })
  })
})

describe("parseStreamJson", () => {
  it("returns plain stdout verbatim when there are no JSON lines", () => {
    const r = parseStreamJson("just some text\nmore text")
    expect(r.resultText).toBe("just some text\nmore text")
    expect(r.activities).toEqual([])
  })

  it("collects tool_use activities with sensible details", () => {
    const stream = jsonl({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Edit", input: { file_path: "a.ts" } },
          { type: "tool_use", name: "Grep", input: { pattern: "foo" } },
          { type: "tool_use", name: "Task", input: { description: "do thing" } },
          { type: "tool_use", name: "Mystery", input: {} },
        ],
      },
    })
    const r = parseStreamJson(stream)
    expect(r.activities).toEqual(["Edit a.ts", "Grep foo", "Task do thing", "Mystery"])
  })

  it("prefers the result event text and reads usage tokens", () => {
    const stream = jsonl(
      { type: "assistant", message: { content: [{ type: "text", text: "ignored" }] } },
      { type: "result", result: "FINAL", usage: { input_tokens: 11, output_tokens: 22 } },
    )
    const r = parseStreamJson(stream)
    expect(r.resultText).toBe("FINAL")
    expect(r.tokensIn).toBe(11)
    expect(r.tokensOut).toBe(22)
  })

  it("falls back to concatenated assistant text when no result event", () => {
    const stream = jsonl(
      { type: "assistant", message: { content: [{ type: "text", text: "line1" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "line2" }] } },
    )
    const r = parseStreamJson(stream)
    expect(r.resultText).toBe("line1\nline2")
  })

  it("skips malformed JSON lines without throwing", () => {
    const stream = `not json\n${JSON.stringify({ type: "result", result: "ok" })}\n{broken`
    const r = parseStreamJson(stream)
    expect(r.resultText).toBe("ok")
  })
})
