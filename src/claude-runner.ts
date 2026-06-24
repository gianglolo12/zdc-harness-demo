import { execa } from "execa"

export type ClaudeRunnerOpts = {
  cwd: string
  command: string
  input?: string
  runner?: ClaudeRunner
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

// Default runner uses execa to invoke `claude -p <command>`
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

export async function runClaude(opts: ClaudeRunnerOpts): Promise<ClaudeResult> {
  // --dangerously-skip-permissions: the worker runs claude headless inside an
  // isolated container; without it, Edit/Write/Bash tools block on a permission
  // prompt with no approver, so /auto-implement can't edit files or git-push
  // (Phase 1 = read-only analysis worked; Phase 2 = needs tools, silently no-op'd).
  const args = ["--dangerously-skip-permissions", "-p", opts.command]
  const runner = opts.runner ?? defaultRunner
  const { stdout } = await runner(opts, args)
  return { stdout, ...parseTokenFooter(stdout) }
}
