import type { Registry } from "../registry.js"
import type { OverlayOpts } from "../overlay.js"
import type { ClaudeRunnerOpts, ClaudeResult } from "../claude-runner.js"
import type { MemoryStore } from "../memory-store.js"
import type { Enqueuer } from "../queue.js"
import type { Phase2JobIntent } from "./human-gate.js"
import type { ImpactJobIntent } from "../classifier.js"

// ─── Injected dependency types ────────────────────────────────────────────────

type RunClaudeFn = (opts: ClaudeRunnerOpts) => Promise<ClaudeResult>
type OverlayFn = (opts: OverlayOpts) => Promise<void>
type CheckoutFn = (opts: { sourceRepo: string; ref: string; destDir?: string }) => Promise<string>

/** Shape of the JSON footer emitted by the /auto-implement agent on stdout. */
interface AgentFooter {
  pushed: boolean
  mr_iid: number
  affects_fe: boolean
  api_contract: string
}

export interface Phase2Deps {
  intent: Phase2JobIntent
  registry: Registry
  checkout: CheckoutFn
  overlay: OverlayFn
  runClaude: RunClaudeFn
  gitlab: {
    finalizeMR(projectId: number, mrIid: number): Promise<unknown>
    commentMR(projectId: number, mrIid: number, body: string): Promise<unknown>
  }
  memory: Pick<MemoryStore, "write">
  enqueuer: Enqueuer
  projectId: number
  controlPlaneDir: string
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

/**
 * Phase 2 pipeline:
 *   resolve registry → checkout source → overlay bundle →
 *   runClaude /auto-implement (agent codes+tests+pushes itself) →
 *   gitlab.finalizeMR (un-draft) →
 *   memory.write(lesson distilled from run) →
 *   if affects_fe && target=be → enqueue impact job for fe with api_contract handoff
 */
export async function runPhase2(deps: Phase2Deps): Promise<void> {
  const { intent, registry, checkout, overlay, runClaude, gitlab, memory, enqueuer, projectId, controlPlaneDir } = deps

  // 1. Resolve registry entry
  const entry = registry.repos[intent.target]
  if (!entry) {
    throw new Error(`Registry: no entry for target "${intent.target}"`)
  }

  // 2. Checkout source repo at the given ref
  const checkoutDir = await checkout({ sourceRepo: entry.sourceRepo, ref: intent.ref })

  // 3. Overlay agent bundle into the checkout
  await overlay({ checkoutDir, controlPlaneDir, bundle: entry.bundle })

  // 4. Run /auto-implement (agent handles coding, tests, and pushing itself)
  const input = buildImplementInput({ prd: intent.prd, ref: intent.ref, mrIid: intent.mrIid })
  const { stdout } = await runClaude({ cwd: checkoutDir, command: "/auto-implement", input })

  // 5. Parse JSON footer from agent stdout (best-effort)
  const footer = parseAgentFooter(stdout)

  // 6. Finalize MR (un-draft)
  await gitlab.finalizeMR(projectId, intent.mrIid)

  // 7. Write lesson to memory
  memory.write({
    repo: entry.sourceRepo,
    area: intent.target,
    errorSignature: `phase2:${intent.prd}`,
    issue: `Phase 2 implementation for PRD ${intent.prd} on ${intent.target}`,
    rootCause: `Automated implementation via /auto-implement for ref ${intent.ref}`,
    fix: footer
      ? `Agent pushed: ${footer.pushed}; MR !${footer.mr_iid}; affects_fe: ${footer.affects_fe}`
      : `Agent run complete (no structured footer)`,
    tags: ["phase2", intent.target, intent.prd],
  })

  // 8. FE handoff: if agent reports FE impact and this job is for the BE, enqueue fe impact.
  // I3: do NOT reuse the BE ref — the FE repo likely lacks that branch. Use "main" as the
  // default base branch so the clone succeeds on the FE repo's default branch.
  if (footer?.affects_fe && intent.target === "be") {
    const feJob: ImpactJobIntent = {
      type: "impact",
      target: "fe",
      prd: intent.prd,
      ref: "main",
      api_contract: footer.api_contract,
    }
    await enqueuer.enqueue(feJob)
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildImplementInput(opts: { prd: string; ref: string; mrIid: number }): string {
  return [`PRD: ${opts.prd}`, `Branch: ${opts.ref}`, `MR: !${opts.mrIid}`].join("\n")
}

/** Parse the JSON footer emitted as the last line of stdout by the agent. */
function parseAgentFooter(stdout: string): AgentFooter | null {
  const lastLine = stdout.trimEnd().split("\n").at(-1) ?? ""
  try {
    const parsed = JSON.parse(lastLine) as Record<string, unknown>
    if (
      typeof parsed["pushed"] === "boolean" &&
      typeof parsed["mr_iid"] === "number" &&
      typeof parsed["affects_fe"] === "boolean" &&
      typeof parsed["api_contract"] === "string"
    ) {
      return parsed as unknown as AgentFooter
    }
  } catch {
    // Not a JSON footer — ignore
  }
  return null
}
