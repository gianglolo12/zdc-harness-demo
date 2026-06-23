import type { JobIntent, ImpactJobIntent } from "./classifier.js"
import type { Enqueuer } from "./queue.js"
import type { Phase2JobIntent } from "./pipeline/human-gate.js"

// ─── Injected dependencies interface ─────────────────────────────────────────

export interface WorkerDeps {
  isPaused: () => boolean
  dryRun: boolean
  /**
   * Pre-bound Phase 1 runner. Accepts only the impact intent; all other
   * Phase1Deps (registry, checkout, overlay, runClaude, etc.) are already
   * captured in the closure supplied by main() or injected by tests.
   */
  runPhase1: (intent: ImpactJobIntent) => Promise<{ mrIid: number }>
  /**
   * Pre-bound Phase 2 runner. Accepts only the phase2 intent; all other
   * Phase2Deps are captured in the closure supplied by main() or injected by tests.
   */
  runPhase2: (intent: Phase2JobIntent) => Promise<void>
  /**
   * Pre-bound human-gate command handler. Accepts approve/revise/reject/abort
   * intents; all HumanGateDeps are already captured in the closure supplied by
   * main() or injected by tests.
   */
  handleCommand: (intent: Extract<JobIntent, { mrIid: number }>) => Promise<void>
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

  if (intent.type === "phase2") {
    await deps.runPhase2(intent as Phase2JobIntent)
    console.log(`[worker] Phase 2 complete for MR !${intent.mrIid}`)
    return
  }

  if (intent.type === "approve" || intent.type === "revise" || intent.type === "reject" || intent.type === "abort") {
    await deps.handleCommand(intent as Extract<JobIntent, { mrIid: number }>)
    return
  }

  if (intent.type !== "impact") {
    console.log("[worker] unknown intent type, skipping:", intent.type)
    return
  }

  // Narrowed by the intent.type !== "impact" guard above — no cast needed.
  const impactIntent = intent as ImpactJobIntent

  const { mrIid } = await deps.runPhase1(impactIntent)

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
  const { runPhase1: runPhase1Full } = await import("./pipeline/phase1-impact.js")
  const { runPhase2: runPhase2Full } = await import("./pipeline/phase2-implement.js")
  const { handleCommand: handleCommandFull } = await import("./pipeline/human-gate.js")
  const { isPaused } = await import("./kill-switch.js")
  const { fromConfig: createGitLabClient } = await import("./gitlab.js")
  const { bullmqEnqueuer, createQueue } = await import("./queue.js")
  const { loadRegistry } = await import("./registry.js")
  const { overlay } = await import("./overlay.js")
  const { runClaude } = await import("./claude-runner.js")
  const { reviewSolution } = await import("./pipeline/second-opinion.js")
  const { SqliteMemoryStore } = await import("./memory-store.js")
  const { RedisStateStore } = await import("./state-store.js")
  const { readFileSync } = await import("node:fs")
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const { mkdtempSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const execFileAsync = promisify(execFile)

  const cfg = loadConfig(process.env as Record<string, string | undefined>)
  const connection = new IORedis(cfg.redisUrl, { maxRetriesPerRequest: null })
  const queue = await createQueue("zdc-jobs", connection)
  const enqueuer = bullmqEnqueuer(queue)
  const gitlab = createGitLabClient(cfg)
  const projectId = Number(process.env["GITLAB_PROJECT_ID"] ?? 0)
  const controlPlaneDir = process.env["CONTROL_PLANE_DIR"] ?? ""

  // Load registry from YAML file in the control plane directory.
  const registryText = readFileSync(`${controlPlaneDir}/registry.yaml`, "utf8")
  const registry = loadRegistry(registryText)

  const memory = new SqliteMemoryStore()
  const stateStore = new RedisStateStore(connection)

  // Real git checkout: clone/fetch source repo at ref into a temp directory.
  // I3: if --branch <ref> fails (e.g. FE repo has no matching BE branch), fall back to
  // a default clone without --branch so the FE handoff job can succeed on main.
  const checkout = async (opts: { sourceRepo: string; ref: string }): Promise<string> => {
    const dest = mkdtempSync(`${tmpdir()}/zdc-checkout-`)
    try {
      await execFileAsync("git", ["clone", "--depth=1", "--branch", opts.ref, opts.sourceRepo, dest])
    } catch {
      // Branch not found in remote — clone default branch and let agent create its own.
      await execFileAsync("git", ["clone", "--depth=1", opts.sourceRepo, dest])
    }
    return dest
  }

  const deps: WorkerDeps = {
    isPaused: () => isPaused(),
    dryRun: cfg.dryRun,
    // Pre-bound closure: captures all Phase1Deps; processJob only passes the intent.
    runPhase1: (intent) =>
      runPhase1Full({
        intent,
        registry,
        checkout,
        overlay,
        runClaude,
        reviewSolution,
        gitlab: {
          createDraftMR: gitlab.createDraftMR.bind(gitlab),
          commentMR: gitlab.commentMR.bind(gitlab),
          getMR: gitlab.getMR.bind(gitlab),
        },
        memory,
        state: stateStore,
        projectId,
        controlPlaneDir,
      }),
    // Pre-bound closure: captures all Phase2Deps; processJob only passes the intent.
    runPhase2: (intent) =>
      runPhase2Full({
        intent,
        registry,
        checkout,
        overlay,
        runClaude,
        gitlab: {
          finalizeMR: gitlab.finalizeMR.bind(gitlab),
          commentMR: gitlab.commentMR.bind(gitlab),
        },
        memory,
        enqueuer,
        projectId,
        controlPlaneDir,
      }),
    // Pre-bound closure: captures HumanGateDeps; processJob only passes the intent.
    handleCommand: (intent) =>
      handleCommandFull(intent, {
        state: stateStore,
        gitlab: {
          commentMR: gitlab.commentMR.bind(gitlab),
          setLabel: gitlab.setLabel.bind(gitlab),
        },
        enqueuer,
        dryRun: cfg.dryRun,
        projectId,
      }),
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
