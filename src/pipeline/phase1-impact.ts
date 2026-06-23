import type { Registry } from "../registry.js"
import type { OverlayOpts } from "../overlay.js"
import type { ClaudeRunnerOpts, ClaudeResult } from "../claude-runner.js"
import type { ReviewResult } from "./second-opinion.js"
import type { MemoryStore, MemoryEntry } from "../memory-store.js"
import type { GitLabClient } from "../gitlab.js"
import type { StateStore } from "../state-store.js"

// ─── Intent shape (impact variant only) ───────────────────────────────────────

export interface ImpactIntent {
  type: "impact"
  target: string
  prd: string
  ref: string
  /** Human revise feedback to surface in the agent prompt (I1). */
  feedback?: string
  /** BE→FE API contract from Phase 2 handoff (I2). */
  api_contract?: string
}

// ─── Injected dependencies ────────────────────────────────────────────────────

export interface CheckoutOpts {
  sourceRepo: string
  ref: string
  /** destination directory — caller decides; in tests it's a tmp path */
  destDir?: string
}

type RunClaudeFn = (opts: ClaudeRunnerOpts) => Promise<ClaudeResult>
type ReviewSolutionFn = (opts: { cwd: string; solution: string; runClaude: RunClaudeFn }) => Promise<ReviewResult>
type OverlayFn = (opts: OverlayOpts) => Promise<void>
type CheckoutFn = (opts: CheckoutOpts) => Promise<string>

export interface Phase1Deps {
  intent: ImpactIntent
  registry: Registry
  /** Clones/fetches source repo at the given ref; returns local checkout path */
  checkout: CheckoutFn
  overlay: OverlayFn
  runClaude: RunClaudeFn
  reviewSolution: ReviewSolutionFn
  gitlab: Pick<GitLabClient, "createDraftMR" | "commentMR" | "getMR">
  memory: Pick<MemoryStore, "search">
  /** State store used to persist job details after MR creation (C1). */
  state: Pick<StateStore, "putJob">
  projectId: number
  controlPlaneDir: string
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 2

/**
 * Phase 1 pipeline:
 *   resolve registry → checkout source → overlay bundle →
 *   memory.search(prd/area) → runClaude /auto-impact (≤2 attempts) →
 *   gitlab.createDraftMR → { mrIid }
 */
export async function runPhase1(deps: Phase1Deps): Promise<{ mrIid: number }> {
  const { intent, registry, checkout, overlay, runClaude, reviewSolution, gitlab, memory, state, projectId, controlPlaneDir } =
    deps

  // 1. Resolve registry entry
  const entry = registry.repos[intent.target]
  if (!entry) {
    throw new Error(`Registry: no entry for target "${intent.target}"`)
  }

  // 2. Checkout source repo at the given ref
  const checkoutDir = await checkout({ sourceRepo: entry.sourceRepo, ref: intent.ref })

  // 3. Overlay agent bundle into the checkout
  await overlay({ checkoutDir, controlPlaneDir, bundle: entry.bundle })

  // 4. Load relevant memory entries.
  // Search by the PRD identifier so FTS matches issue/rootCause/fix text that
  // references this PRD. The `area` filter is intentionally omitted: intent.target
  // is a registry bundle key ("be"/"fe"), not a semantic memory area ("payment"/"auth"),
  // so filtering by it would exclude all rows.
  const memoryEntries: MemoryEntry[] = memory.search({ text: intent.prd })

  const memoryContext = buildMemoryContext(memoryEntries)

  // 5. Run /auto-impact with retry loop (max MAX_ATTEMPTS)
  let solution = ""
  let reviewNotes = ""

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const input = buildImpactInput({
      prd: intent.prd,
      ref: intent.ref,
      memoryContext,
      reviewNotes,
      feedback: intent.feedback,
      apiContract: intent.api_contract,
    })

    const { stdout } = await runClaude({ cwd: checkoutDir, command: "/auto-impact", input })
    solution = stdout

    // 6. Second-opinion review
    const review = await reviewSolution({ cwd: checkoutDir, solution, runClaude })
    if (review.verdict === "pass") break

    // If fail and last attempt, use the solution as-is
    reviewNotes = review.notes
  }

  // 7. Create draft MR
  const mrTitle = `Impact analysis: ${intent.prd} → ${intent.target}`
  const mrBody = buildMRBody({ solution, memoryEntries })

  const mr = (await gitlab.createDraftMR(projectId, intent.ref, mrTitle, mrBody)) as { iid: number }

  // C1: Persist job state so human-gate can retrieve target/prd/ref on /approve or /revise.
  await state.putJob(String(mr.iid), {
    target: intent.target,
    prd: intent.prd,
    ref: intent.ref,
    phase: "phase1",
    revisionCount: 0,
  })

  return { mrIid: mr.iid }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildMemoryContext(entries: MemoryEntry[]): string {
  if (entries.length === 0) return ""
  return entries
    .map((e) => `- [${e.id}] ${e.issue}: ${e.fix}`)
    .join("\n")
}

function buildImpactInput(opts: {
  prd: string
  ref: string
  memoryContext: string
  reviewNotes: string
  feedback?: string
  apiContract?: string
}): string {
  const parts: string[] = [
    `PRD: ${opts.prd}`,
    `Branch: ${opts.ref}`,
  ]
  if (opts.memoryContext) {
    parts.push(`\nRelevant memory:\n${opts.memoryContext}`)
  }
  if (opts.reviewNotes) {
    parts.push(`\nReview feedback (please address):\n${opts.reviewNotes}`)
  }
  // I1: surface human revise feedback so the agent addresses it
  if (opts.feedback) {
    parts.push(`\nHuman feedback (please address):\n${opts.feedback}`)
  }
  // I2: include BE→FE API contract when this is an FE handoff job
  if (opts.apiContract) {
    parts.push(`\nAPI contract (implement against this interface):\n${opts.apiContract}`)
  }
  return parts.join("\n")
}

function buildMRBody(opts: { solution: string; memoryEntries: MemoryEntry[] }): string {
  const memRefs = opts.memoryEntries.map((e) => e.id)
  const memSection =
    memRefs.length > 0
      ? `\n\n---\n**memory_refs:** ${memRefs.join(", ")}`
      : "\n\n---\n**memory_refs:** (none)"

  return `${opts.solution}${memSection}`
}
