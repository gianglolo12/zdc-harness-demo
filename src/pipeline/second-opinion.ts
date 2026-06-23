import type { ClaudeRunnerOpts, ClaudeResult } from "../claude-runner.js"

type RunClaudeFn = (opts: ClaudeRunnerOpts) => Promise<ClaudeResult>

export type ReviewOpts = {
  cwd: string
  solution: string
  runClaude: RunClaudeFn
}

export type ReviewResult = {
  verdict: "pass" | "fail"
  notes: string
}

const PARSE_FAILURE: ReviewResult = {
  verdict: "fail",
  notes: "unparseable review output",
}

export async function reviewSolution(opts: ReviewOpts): Promise<ReviewResult> {
  const { cwd, solution, runClaude } = opts

  const { stdout } = await runClaude({
    cwd,
    command: "/auto-review-solution",
    input: solution,
  })

  try {
    const parsed = JSON.parse(stdout) as { verdict: unknown; notes: unknown }
    // Validate verdict is exactly "pass" or "fail" — any other value (e.g. "maybe")
    // is treated as fail to avoid leaking arbitrary strings into ReviewResult.
    const verdict = parsed.verdict === "pass" ? "pass" : "fail"
    const notes = typeof parsed.notes === "string" ? parsed.notes : ""
    return { verdict, notes }
  } catch {
    return PARSE_FAILURE
  }
}
