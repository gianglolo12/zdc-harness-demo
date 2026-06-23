import type { JobIntent } from "./classifier.js"
import type { Phase1Deps } from "./pipeline/phase1-impact.js"
import type { Enqueuer } from "./queue.js"

// ─── Injected dependencies interface ─────────────────────────────────────────

export interface WorkerDeps {
  isPaused: () => boolean
  dryRun: boolean
  /** Runs Phase 1 pipeline; returns { mrIid } */
  runPhase1: (deps: Phase1Deps) => Promise<{ mrIid: number }>
  gitlab: {
    commentMR(projectId: number, mrIid: number, body: string): Promise<unknown>
  }
  enqueuer: Enqueuer
  projectId: number
}

// ─── Core processor (unit-testable, no live deps) ─────────────────────────────

/**
 * Processes a single job intent.
 *
 * - If kill-switch is active → held (no-op).
 * - If intent.type === "impact" → run Phase 1.
 *   - dry-run mode: after Phase 1 posts a comment and stops (no Phase 2 enqueue).
 *   - live mode: result is available for Phase 2 (enqueued by Task 13+).
 * - Other intent types (approve/revise/reject/abort) → handled by Task 13; no-op here.
 */
export async function processJob(intent: JobIntent, deps: WorkerDeps): Promise<void> {
  if (deps.isPaused()) {
    console.log("[worker] kill-switch active — job held:", intent.type)
    return
  }

  if (intent.type !== "impact") {
    // approve/revise/reject/abort handled by Task 13 human-gate handler
    console.log("[worker] non-impact intent deferred to human-gate handler:", intent.type)
    return
  }

  // Cast is safe — we checked intent.type above
  const impactIntent = intent as Extract<JobIntent, { type: "impact" }>

  const { mrIid } = await deps.runPhase1({
    intent: impactIntent,
    // remaining Phase1Deps are provided by main() in production;
    // tests inject a mock runPhase1 so these are never reached in tests.
  } as Phase1Deps)

  if (deps.dryRun) {
    await deps.gitlab.commentMR(
      deps.projectId,
      mrIid,
      "**dry-run: solution only** — Phase 2 (code generation) is disabled in dry-run mode.",
    )
    console.log(`[worker] dry-run complete for MR !${mrIid} — stopping before Phase 2`)
    return
  }

  // Live mode: Phase 2 enqueue handled by Task 13+
  console.log(`[worker] Phase 1 complete for MR !${mrIid}`)
}

// ─── Production entry point ───────────────────────────────────────────────────

/**
 * Wires real Redis/BullMQ/GitLab and starts consuming jobs.
 * NOT exercised by unit tests.
 */
export async function main() {
  const { Worker } = await import("bullmq")
  const { default: IORedis } = await import("ioredis")
  const { loadConfig } = await import("./config.js")
  const { runPhase1 } = await import("./pipeline/phase1-impact.js")
  const { isPaused } = await import("./kill-switch.js")
  const { fromConfig: createGitLabClient } = await import("./gitlab.js")
  const { bullmqEnqueuer, createQueue } = await import("./queue.js")

  const cfg = loadConfig(process.env as Record<string, string | undefined>)
  const connection = new IORedis(cfg.redisUrl, { maxRetriesPerRequest: null })
  const queue = await createQueue("zdc-jobs", connection)
  const enqueuer = bullmqEnqueuer(queue)
  const gitlab = createGitLabClient(cfg)
  const projectId = Number(process.env["GITLAB_PROJECT_ID"] ?? 0)

  const deps: WorkerDeps = {
    isPaused: () => isPaused(),
    dryRun: cfg.dryRun,
    runPhase1,
    gitlab: { commentMR: gitlab.commentMR.bind(gitlab) },
    enqueuer,
    projectId,
  }

  const worker = new Worker(
    "zdc-jobs",
    async (job) => {
      await processJob(job.data as JobIntent, deps)
    },
    { connection },
  )

  worker.on("failed", (job, err) => {
    console.error(`[worker] job ${job?.id} failed:`, err)
  })

  console.log("[worker] started, consuming zdc-jobs queue")
}
