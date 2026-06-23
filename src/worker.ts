import type { JobIntent, ImpactJobIntent } from "./classifier.js"
import type { Enqueuer } from "./queue.js"
import type { Phase2JobIntent } from "./pipeline/human-gate.js"
import type { Config } from "./config.js"
import { GitLabClient, fromConfig as gitlabFromConfig } from "./gitlab.js"
import { GitHubClient, fromConfig as githubFromConfig } from "./github.js"

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

// ─── Provider selection ───────────────────────────────────────────────────────

/**
 * Select the correct git client based on cfg.gitProvider.
 * Returns the client instance and a discriminant `kind` string.
 * Exported for unit testing; main() uses it internally.
 */
export function selectGitClient(
  cfg: Config,
): { client: GitLabClient; kind: "gitlab" } | { client: GitHubClient; kind: "github" } {
  if (cfg.gitProvider === "github") {
    return { client: githubFromConfig(cfg), kind: "github" }
  }
  return { client: gitlabFromConfig(cfg), kind: "gitlab" }
}

// ─── Production entry point ───────────────────────────────────────────────────

/**
 * Wires real Redis/BullMQ/GitLab or GitHub and starts consuming jobs.
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
  // Parse redisUrl into plain options so BullMQ uses its own bundled ioredis —
  // avoids the structural type mismatch between the top-level ioredis package
  // and the ioredis copy bundled inside bullmq.
  const redisUrl = new URL(cfg.redisUrl)
  const bullmqConnection = {
    host: redisUrl.hostname,
    port: Number(redisUrl.port) || 6379,
    ...(redisUrl.password ? { password: redisUrl.password } : {}),
    maxRetriesPerRequest: null,
  }
  // Keep a separate ioredis instance for RedisStateStore (typed as unknown there).
  const connection = new IORedis(cfg.redisUrl, { maxRetriesPerRequest: null })
  const queue = await createQueue("zdc-jobs", bullmqConnection)
  const enqueuer = bullmqEnqueuer(queue)
  const controlPlaneDir = process.env["CONTROL_PLANE_DIR"] ?? ""

  // Load registry from YAML file in the control plane directory.
  const registryText = readFileSync(`${controlPlaneDir}/registry.yaml`, "utf8")
  const registry = loadRegistry(registryText)

  const dbPath = process.env["SQLITE_MEMORY_DB"] ?? ":memory:"
  const memory = new SqliteMemoryStore(dbPath)
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

  // Select the correct git client and build provider-agnostic method adapters.
  // Both GitLabClient (takes projectId: number) and GitHubClient (takes repoRef: RepoRef)
  // share the same method names — we bind the identifier here so pipeline closures
  // receive the unified (mrIid, ...) signature they already expect.
  const { client: gitClient, kind: gitKind } = selectGitClient(cfg)

  // Adapter: normalises the first-arg difference between GitLab (number) and GitHub (RepoRef).
  type GitAdapter = {
    createDraftMR(sourceBranch: string, title: string, body: string): Promise<{ iid: number }>
    commentMR(mrIid: number, body: string): Promise<unknown>
    getMR(mrIid: number): Promise<unknown>
    finalizeMR(mrIid: number): Promise<unknown>
    setLabel(mrIid: number, label: string): Promise<unknown>
  }

  let git: GitAdapter
  if (gitKind === "github") {
    const gh = gitClient as import("./github.js").GitHubClient
    const repoRef = cfg.github!
    git = {
      createDraftMR: (branch, title, body) => gh.createDraftMR(repoRef, branch, title, body),
      commentMR: (mrIid, body) => gh.commentMR(repoRef, mrIid, body),
      getMR: (mrIid) => gh.getMR(repoRef, mrIid),
      finalizeMR: (mrIid) => gh.finalizeMR(repoRef, mrIid),
      setLabel: (mrIid, label) => gh.setLabel(repoRef, mrIid, label),
    }
  } else {
    const gl = gitClient as import("./gitlab.js").GitLabClient
    const projectId = Number(process.env["GITLAB_PROJECT_ID"] ?? 0)
    git = {
      createDraftMR: async (branch, title, body) =>
        gl.createDraftMR(projectId, branch, title, body) as Promise<{ iid: number }>,
      commentMR: (mrIid, body) => gl.commentMR(projectId, mrIid, body),
      getMR: (mrIid) => gl.getMR(projectId, mrIid),
      finalizeMR: (mrIid) => gl.finalizeMR(projectId, mrIid),
      setLabel: (mrIid, label) => gl.setLabel(projectId, mrIid, label),
    }
  }

  // projectId is only used in WorkerDeps.gitlab.commentMR (dry-run comment path).
  // For GitHub we use 0 as a placeholder — the real mrIid from the job is what matters;
  // the repoRef is already bound in the git adapter above.
  const projectId = gitKind === "github" ? 0 : Number(process.env["GITLAB_PROJECT_ID"] ?? 0)

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
          createDraftMR: (pid, branch, title, body) => git.createDraftMR(branch, title, body),
          commentMR: (pid, mrIid, body) => git.commentMR(mrIid, body),
          getMR: (pid, mrIid) => git.getMR(mrIid),
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
          finalizeMR: (pid, mrIid) => git.finalizeMR(mrIid),
          commentMR: (pid, mrIid, body) => git.commentMR(mrIid, body),
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
          commentMR: (pid, mrIid, body) => git.commentMR(mrIid, body),
          setLabel: (pid, mrIid, label) => git.setLabel(mrIid, label),
        },
        enqueuer,
        dryRun: cfg.dryRun,
        projectId,
      }),
    gitlab: { commentMR: (pid, mrIid, body) => git.commentMR(mrIid, body) },
    enqueuer,
    projectId,
  }

  const worker = new Worker(
    "zdc-jobs",
    async (job) => {
      await processJob(job.data as JobIntent, deps)
    },
    { connection: bullmqConnection },
  )

  worker.on("failed", (job, err) => {
    console.error(`[worker] job ${job?.id} failed:`, err)
  })

  console.log("[worker] started, consuming zdc-jobs queue")
}
