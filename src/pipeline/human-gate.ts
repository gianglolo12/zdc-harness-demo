import type { JobIntent, ImpactJobIntent } from "../classifier.js"
import type { StateStore } from "../state-store.js"
import type { Enqueuer } from "../queue.js"

// ─── Max revisions before escalating to human ─────────────────────────────────

const MAX_REVISIONS = 3

// ─── Phase 2 job shape ────────────────────────────────────────────────────────

/** Enqueued when /approve is received in live mode. */
export interface Phase2JobIntent {
  type: "phase2"
  mrIid: number
  target: string
  prd: string
  ref: string
}

// ─── Injected dependencies ────────────────────────────────────────────────────

export interface HumanGateGitlab {
  commentMR(projectId: number, mrIid: number, body: string): Promise<unknown>
  setLabel(projectId: number, mrIid: number, label: string): Promise<unknown>
}

export interface HumanGateDeps {
  state: Pick<StateStore, "getJob" | "incRevision">
  gitlab: HumanGateGitlab
  enqueuer: Enqueuer
  dryRun: boolean
  projectId: number
}

// ─── Handler ──────────────────────────────────────────────────────────────────

/**
 * Handles human-gate commands from MR note events.
 *
 * - revise  → increment revision counter; if < MAX_REVISIONS enqueue Phase 1 again
 *             (carrying feedback); if >= MAX_REVISIONS set label + comment, no enqueue.
 * - approve → if dryRun comment "dry-run: skipping implementation"; else enqueue Phase 2.
 * - reject  → comment + mark done; no enqueue.
 * - abort   → comment + mark done; no enqueue.
 */
export async function handleCommand(
  intent: Extract<JobIntent, { mrIid: number }>,
  deps: HumanGateDeps,
): Promise<void> {
  const { state, gitlab, enqueuer, dryRun, projectId } = deps
  const mrIidStr = String(intent.mrIid)

  if (intent.type === "revise") {
    const newCount = await state.incRevision(mrIidStr)

    if (newCount >= MAX_REVISIONS) {
      // Cap reached — escalate to human reviewer
      await gitlab.setLabel(projectId, intent.mrIid, "needs-human")
      await gitlab.commentMR(
        projectId,
        intent.mrIid,
        `⚠️ This MR has been revised ${newCount} times and has been flagged as **needs-human** for manual review. No further automatic revisions will be made.`,
      )
      return
    }

    // Under the cap — re-enqueue Phase 1 with feedback so the agent refines
    const job = await state.getJob(mrIidStr)
    const impactJob: ImpactJobIntent & { feedback?: string } = {
      type: "impact",
      target: job?.target ?? "unknown",
      prd: job?.prd ?? "unknown",
      ref: job?.ref ?? "unknown",
      feedback: intent.feedback,
    }
    await enqueuer.enqueue(impactJob as JobIntent)
    return
  }

  if (intent.type === "approve") {
    if (dryRun) {
      await gitlab.commentMR(
        projectId,
        intent.mrIid,
        "**dry-run: skipping implementation** — Phase 2 (code generation) is disabled in dry-run mode.",
      )
      return
    }

    // Live mode — retrieve stored job details and enqueue Phase 2
    const job = await state.getJob(mrIidStr)
    const phase2Job: Phase2JobIntent = {
      type: "phase2",
      mrIid: intent.mrIid,
      target: job?.target ?? "unknown",
      prd: job?.prd ?? "unknown",
      ref: job?.ref ?? "unknown",
    }
    await enqueuer.enqueue(phase2Job as unknown as JobIntent)
    return
  }

  if (intent.type === "reject" || intent.type === "abort") {
    const action = intent.type
    await gitlab.commentMR(
      projectId,
      intent.mrIid,
      `🚫 Job ${action}ed — this MR will not be processed further by the harness.`,
    )
    return
  }
}
