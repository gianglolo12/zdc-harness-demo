import { execa } from "execa"

export type ClaudeRunnerOpts = {
  cwd: string
  command: string
  input?: string
  runner?: ClaudeRunner
  /**
   * Optional callback invoked once per tool_use parsed from the stream-json
   * output. `text` is a short human-readable description (e.g. "Edit src/x.ts").
   * Best-effort: parse failures never propagate.
   */
  onActivity?: (text: string) => void
}

export type ClaudeRunner = (
  opts: ClaudeRunnerOpts,
  args: string[],
) => Promise<{ stdout: string }>

export type ClaudeResult = {
  stdout: string
  tokensIn?: number
  tokensOut?: number
}

// Default runner uses execa to invoke `claude` with the given args.
const defaultRunner: ClaudeRunner = (opts, args) =>
  execa("claude", args, { cwd: opts.cwd, input: opts.input })

// Parse optional JSON token footer from the last line of stdout (best-effort)
function parseTokenFooter(stdout: string): { tokensIn?: number; tokensOut?: number } {
  const lastLine = stdout.trimEnd().split("\n").at(-1) ?? ""
  try {
    const parsed = JSON.parse(lastLine) as Record<string, unknown>
    const tokensIn = typeof parsed["tokensIn"] === "number" ? parsed["tokensIn"] : undefined
    const tokensOut = typeof parsed["tokensOut"] === "number" ? parsed["tokensOut"] : undefined
    if (tokensIn !== undefined || tokensOut !== undefined) {
      return { tokensIn, tokensOut }
    }
  } catch {
    // Not a JSON footer — ignore
  }
  return {}
}

// ─── stream-json parsing ──────────────────────────────────────────────────────

export interface StreamParseResult {
  /**
   * Final result text. Prefer the `{"type":"result"}` event's `.result`; fall
   * back to the concatenated assistant text when no result event is present.
   */
  resultText: string
  /** Human-readable tool_use activity lines, in order. */
  activities: string[]
  /** Token counts from the result event usage block, if present. */
  tokensIn?: number
  tokensOut?: number
}

/**
 * Describe a single tool_use content block as a short activity line.
 * e.g. {name:"Edit", input:{file_path:"src/x.ts"}} → "Edit src/x.ts".
 */
function describeToolUse(name: unknown, input: unknown): string {
  const tool = typeof name === "string" ? name : "tool"
  const inp = (input ?? {}) as Record<string, unknown>
  const detail =
    (typeof inp["file_path"] === "string" && inp["file_path"]) ||
    (typeof inp["path"] === "string" && inp["path"]) ||
    (typeof inp["command"] === "string" && inp["command"]) ||
    (typeof inp["pattern"] === "string" && inp["pattern"]) ||
    (typeof inp["description"] === "string" && inp["description"]) ||
    ""
  return detail ? `${tool} ${detail}` : tool
}

/**
 * Pure helper: parse claude `--output-format stream-json` JSONL text.
 * Each non-empty line is a JSON object. Tolerant of non-JSON / unexpected
 * lines (skipped). Extracts tool_use activities, the final result text, and
 * token usage. Backward-compatible: when the input is plain (non-JSONL) text,
 * returns it verbatim as resultText with no activities.
 */
export function parseStreamJson(stdout: string): StreamParseResult {
  const activities: string[] = []
  const assistantText: string[] = []
  let resultText: string | undefined
  let tokensIn: number | undefined
  let tokensOut: number | undefined
  // Only stream-json lines carry a recognized `type` (assistant/result/system/
  // user). A legacy plain-text footer like `{"tokensIn":1}` is valid JSON but
  // has no such type — we must NOT treat it as a stream and must leave stdout
  // verbatim so the footer-parse keeps working.
  let sawStreamEvent = false

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim()
    if (!line) continue
    let evt: Record<string, unknown>
    try {
      evt = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue // not a JSON line — skip
    }
    if (typeof evt !== "object" || evt === null) continue
    const type = evt["type"]
    if (type === "assistant" || type === "result" || type === "system" || type === "user") {
      sawStreamEvent = true
    }

    if (type === "assistant") {
      const message = evt["message"] as Record<string, unknown> | undefined
      const content = message?.["content"]
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as Record<string, unknown>
          if (b["type"] === "tool_use") {
            activities.push(describeToolUse(b["name"], b["input"]))
          } else if (b["type"] === "text" && typeof b["text"] === "string") {
            assistantText.push(b["text"])
          }
        }
      }
    } else if (type === "result") {
      if (typeof evt["result"] === "string") resultText = evt["result"]
      const usage = evt["usage"] as Record<string, unknown> | undefined
      if (usage) {
        if (typeof usage["input_tokens"] === "number") tokensIn = usage["input_tokens"]
        if (typeof usage["output_tokens"] === "number") tokensOut = usage["output_tokens"]
      }
    }
  }

  // No recognized stream events → treat as legacy plain stdout (preserves the
  // footer-parse path for injected runners that return a plain footer).
  if (!sawStreamEvent) {
    return { resultText: stdout, activities }
  }

  const finalText = resultText ?? assistantText.join("\n")
  return { resultText: finalText, activities, tokensIn, tokensOut }
}

export async function runClaude(opts: ClaudeRunnerOpts): Promise<ClaudeResult> {
  // --dangerously-skip-permissions: the worker runs claude headless inside an
  // isolated container; without it, Edit/Write/Bash tools block on a permission
  // prompt with no approver, so /auto-implement can't edit files or git-push.
  //
  // --output-format stream-json --verbose: emit JSONL so we can surface live
  // tool_use activity. The final result text is extracted and returned as
  // `stdout` so Phase 2's footer-parse keeps working unchanged.
  const args = [
    "--dangerously-skip-permissions",
    "--output-format",
    "stream-json",
    "--verbose",
    "-p",
    opts.command,
  ]
  const runner = opts.runner ?? defaultRunner
  const { stdout: raw } = await runner(opts, args)

  const parsed = parseStreamJson(raw)
  if (opts.onActivity) {
    for (const a of parsed.activities) {
      try {
        opts.onActivity(a)
      } catch {
        // best-effort — never let an onActivity throw abort the run
      }
    }
  }

  const stdout = parsed.resultText
  // Token usage: prefer stream-json usage; fall back to a JSON footer on the
  // result text (legacy / injected runners that return a plain footer).
  const footer = parseTokenFooter(stdout)
  const tokensIn = parsed.tokensIn ?? footer.tokensIn
  const tokensOut = parsed.tokensOut ?? footer.tokensOut
  return {
    stdout,
    ...(tokensIn !== undefined ? { tokensIn } : {}),
    ...(tokensOut !== undefined ? { tokensOut } : {}),
  }
}
