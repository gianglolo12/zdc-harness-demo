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
    const parsed = JSON.parse(stdout) as { verdict: "pass" | "fail"; notes: string }
    return { verdict: parsed.verdict, notes: parsed.notes }
  } catch {
    return PARSE_FAILURE
  }
}
