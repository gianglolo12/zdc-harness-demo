/**
 * examples/run-demo.ts
 *
 * End-to-end demo of the zdc-harness event-driven pipeline with NO external
 * services (no real GitHub, no real Claude, no Redis, no git checkout).
 *
 * Run: npx tsx examples/run-demo.ts   OR   npm run demo
 */

import { tmpdir } from "node:os"
import { mkdtemp, mkdir, writeFile, cp } from "node:fs/promises"
import { join } from "node:path"

// ── Production pipeline imports ───────────────────────────────────────────────
import { classifyGithub } from "../src/classifier-github.js"
import { runPhase1 } from "../src/pipeline/phase1-impact.js"
import { runPhase2 } from "../src/pipeline/phase2-implement.js"
import { handleCommand } from "../src/pipeline/human-gate.js"
import { processJob } from "../src/worker.js"
import { InMemoryStateStore } from "../src/state-store.js"
import { SqliteMemoryStore } from "../src/memory-store.js"
import type { JobIntent } from "../src/classifier.js"
import type { Phase2JobIntent } from "../src/pipeline/human-gate.js"
import type { Registry } from "../src/registry.js"
import type { ClaudeRunnerOpts } from "../src/claude-runner.js"

// ── Constants ─────────────────────────────────────────────────────────────────

const CONTROL_PLANE_DIR = new URL("./control-plane", import.meta.url).pathname
const SOURCE_REPO = "https://github.com/example/be-service.git"
const TARGET = "be"
const PRD = "PRD-001"
const BRANCH = "feature/zdc-be-PRD-001"

// ── Section printer ───────────────────────────────────────────────────────────

let sectionNum = 0
function section(title: string): void {
  sectionNum++
  console.log("\n" + "═".repeat(70))
  console.log(`  (${sectionNum}) ${title}`)
  console.log("═".repeat(70))
}

// ── Fake GitHub client ────────────────────────────────────────────────────────

const githubActions: string[] = []
let prCounter = 0

const fakeGitHub = {
  createDraftMR: async (projectId: number, sourceBranch: string, title: string, body: string) => {
    prCounter++
    const iid = prCounter
    const msg = `[fakeGitHub] createDraftMR  PR#${iid}  branch="${sourceBranch}"  title="${title}"`
    console.log(msg)
    githubActions.push(msg)
    return { iid }
  },
  commentMR: async (projectId: number, mrIid: number, body: string) => {
    const preview = body.length > 80 ? body.slice(0, 80) + "…" : body
    const msg = `[fakeGitHub] commentMR      PR#${mrIid}  "${preview}"`
    console.log(msg)
    githubActions.push(msg)
  },
  getMR: async (projectId: number, mrIid: number) => {
    const msg = `[fakeGitHub] getMR          PR#${mrIid}`
    console.log(msg)
    githubActions.push(msg)
    return { iid: mrIid, state: "opened" }
  },
  finalizeMR: async (projectId: number, mrIid: number) => {
    const msg = `[fakeGitHub] finalizeMR     PR#${mrIid}  (un-drafted → ready for review)`
    console.log(msg)
    githubActions.push(msg)
  },
  setLabel: async (projectId: number, mrIid: number, label: string) => {
    const msg = `[fakeGitHub] setLabel       PR#${mrIid}  label="${label}"`
    console.log(msg)
    githubActions.push(msg)
  },
}

// ── Stub Claude runner ────────────────────────────────────────────────────────
// Returns canned output keyed by command string.

function stubClaude(opts: ClaudeRunnerOpts): Promise<{ stdout: string }> {
  console.log(`  [stubClaude] command="${opts.command}"  cwd="${opts.cwd}"`)

  if (opts.command === "/auto-impact") {
    const stdout = `## Impact Analysis — PRD-001 Create Order

### Summary
Adding a \`POST /orders\` endpoint to the BE service. Requires a new route,
service layer, and database migrations for \`orders\` + \`order_items\` tables.

### Files to change
- \`src/routes/orders.ts\` — new Fastify route (create)
- \`src/services/order-service.ts\` — business logic + DB writes
- \`src/db/migrations/0010_create_orders.sql\` — schema migration
- \`src/db/migrations/0011_create_order_items.sql\` — line-items table

### API contract
\`\`\`
POST /orders → 201 { orderId, status, createdAt }
\`\`\`

### Risk: low`
    return Promise.resolve({ stdout })
  }

  if (opts.command === "/auto-review-solution") {
    return Promise.resolve({
      stdout: JSON.stringify({ verdict: "pass", notes: "Analysis is thorough and covers all acceptance criteria." }),
    })
  }

  if (opts.command === "/auto-implement") {
    // The last line must be the JSON footer parsed by parseAgentFooter
    const mrIid = prCounter // whatever was last created
    const stdout = `Implementing PRD-001 Create Order...

✓ Created src/routes/orders.ts
✓ Created src/services/order-service.ts
✓ Created migration files
✓ Wrote unit tests (coverage 83%)
✓ Committed and pushed branch ${BRANCH}
{"pushed":true,"mr_iid":${mrIid},"affects_fe":false,"api_contract":null}`
    return Promise.resolve({ stdout })
  }

  // Fallback
  return Promise.resolve({ stdout: `{"verdict":"pass","notes":""}` })
}

// ── Fake checkout (no-op — returns a temp dir with minimal structure) ─────────

async function fakeCheckout(opts: { sourceRepo: string; ref: string; destDir?: string }): Promise<string> {
  const dir = opts.destDir ?? (await mkdtemp(join(tmpdir(), "zdc-demo-checkout-")))
  // Create minimal structure so overlay.cp doesn't fail
  await mkdir(join(dir, ".claude"), { recursive: true })
  console.log(`  [fakeCheckout] repo="${opts.sourceRepo}"  ref="${opts.ref}"  → ${dir}`)
  return dir
}

// ── Fake overlay (copies control-plane into the temp checkout dir) ────────────

async function fakeOverlay(opts: { checkoutDir: string; controlPlaneDir: string; bundle: string }): Promise<void> {
  console.log(`  [fakeOverlay] bundle="${opts.bundle}"  → ${opts.checkoutDir}`)
  // Copy the shared skills so runClaude stub has something to reference
  const sharedSrc = join(opts.controlPlaneDir, ".claude")
  const dest = join(opts.checkoutDir, ".claude")
  try {
    await cp(sharedSrc, dest, { recursive: true, force: true })
  } catch {
    // If the source doesn't exist yet (first run), just create the dir
    await mkdir(dest, { recursive: true })
  }
}

// ── In-memory enqueuer that chains back into processJob ───────────────────────
// Guards against infinite loops with a max-steps counter.

const MAX_STEPS = 10
let stepCount = 0
const enqueuedJobs: JobIntent[] = []

// We declare workerDeps lazily so the enqueuer closure can reference it.
let workerDepsRef: Parameters<typeof processJob>[1] | null = null

const inMemoryEnqueuer = {
  async enqueue(intent: JobIntent): Promise<void> {
    enqueuedJobs.push(intent)
    console.log(`  [enqueuer] enqueued type="${intent.type}"`)
    stepCount++
    if (stepCount >= MAX_STEPS) {
      console.warn("  [enqueuer] MAX_STEPS reached — stopping chain")
      return
    }
    if (workerDepsRef) {
      await processJob(intent, workerDepsRef)
    }
  },
}

// ── Registry (in-memory, no YAML file needed) ─────────────────────────────────

const registry: Registry = {
  repos: {
    be: {
      sourceRepo: SOURCE_REPO,
      bundle: "be",
      controlPlaneRef: "main",
    },
  },
}

// ── State + memory stores ─────────────────────────────────────────────────────

const stateStore = new InMemoryStateStore()
const memoryStore = new SqliteMemoryStore(":memory:")

// ── Wire WorkerDeps ───────────────────────────────────────────────────────────

const workerDeps: Parameters<typeof processJob>[1] = {
  isPaused: () => false,
  dryRun: false,

  runPhase1: (intent) =>
    runPhase1({
      intent,
      registry,
      checkout: fakeCheckout,
      overlay: fakeOverlay,
      runClaude: stubClaude,
      reviewSolution: (opts) =>
        stubClaude({ cwd: opts.cwd, command: "/auto-review-solution", input: opts.solution }).then((r) => {
          try {
            const p = JSON.parse(r.stdout) as { verdict: unknown; notes: unknown }
            return {
              verdict: p.verdict === "pass" ? "pass" : "fail",
              notes: typeof p.notes === "string" ? p.notes : "",
            }
          } catch {
            return { verdict: "fail", notes: "unparseable" }
          }
        }),
      gitlab: fakeGitHub,
      memory: memoryStore,
      state: stateStore,
      projectId: 0,
      controlPlaneDir: CONTROL_PLANE_DIR,
    }),

  runPhase2: (intent: Phase2JobIntent) =>
    runPhase2({
      intent,
      registry,
      checkout: fakeCheckout,
      overlay: fakeOverlay,
      runClaude: stubClaude,
      gitlab: {
        finalizeMR: (pid, mrIid) => fakeGitHub.finalizeMR(pid, mrIid),
        commentMR: (pid, mrIid, body) => fakeGitHub.commentMR(pid, mrIid, body),
      },
      memory: memoryStore,
      enqueuer: inMemoryEnqueuer,
      projectId: 0,
      controlPlaneDir: CONTROL_PLANE_DIR,
    }),

  handleCommand: (intent) =>
    handleCommand(intent, {
      state: stateStore,
      gitlab: {
        commentMR: (pid, mrIid, body) => fakeGitHub.commentMR(pid, mrIid, body),
        setLabel: (pid, mrIid, label) => fakeGitHub.setLabel(pid, mrIid, label),
      },
      enqueuer: inMemoryEnqueuer,
      dryRun: false,
      projectId: 0,
    }),

  // Dry-run comment path in worker (only used when dryRun=true, included for completeness)
  gitlab: {
    commentMR: (pid, mrIid, body) => fakeGitHub.commentMR(pid, mrIid, body),
  },
  enqueuer: inMemoryEnqueuer,
  projectId: 0,
}

// Assign so the enqueuer closure can call back into processJob
workerDepsRef = workerDeps

// ─────────────────────────────────────────────────────────────────────────────
// MAIN DEMO
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n🚀  zdc-harness end-to-end demo (all stubs — no external services)")

  // ── (1) Push webhook → classify ────────────────────────────────────────────
  section("PUSH webhook → classifyGithub → intent")

  const pushPayload = {
    ref: `refs/heads/${BRANCH}`,
    commits: [
      {
        message: `feat: scaffold order route [zdc:update-${TARGET} ${PRD}]`,
        added: [`po/${PRD}-create-order.md`],
        modified: [],
        removed: [],
      },
    ],
  }

  const pushIntent = classifyGithub("push", pushPayload)
  console.log("Webhook payload ref:", pushPayload.ref)
  console.log("Classified intent  :", JSON.stringify(pushIntent, null, 2))

  if (pushIntent.type !== "impact") {
    console.error("ERROR: expected impact intent, got:", pushIntent.type)
    process.exit(1)
  }

  // ── (2) processJob(impact) → Phase 1 ──────────────────────────────────────
  section("processJob(impact) → Phase 1 (impact analysis + draft PR)")

  await processJob(pushIntent, workerDeps)

  const mrIid = prCounter
  console.log(`\n→ Draft PR created: PR#${mrIid}`)

  // Show state persisted by Phase 1
  const jobState = await stateStore.getJob(String(mrIid))
  console.log("→ State stored for PR:", JSON.stringify(jobState, null, 2))

  // ── (3) /approve comment → classifyGithub → processJob(approve) → phase2 ──
  section("issue_comment /approve → classifyGithub → handleCommand → phase2 enqueued")

  const approvePayload = {
    action: "created",
    issue: {
      number: mrIid,
      pull_request: { url: `https://api.github.com/repos/example/be-service/pulls/${mrIid}` },
    },
    comment: {
      body: "/approve",
    },
  }

  const approveIntent = classifyGithub("issue_comment", approvePayload)
  console.log("Classified intent:", JSON.stringify(approveIntent, null, 2))

  if (approveIntent.type !== "approve") {
    console.error("ERROR: expected approve intent, got:", approveIntent.type)
    process.exit(1)
  }

  // processJob(approve) → handleCommand → enqueues phase2 → processJob(phase2) [via inMemoryEnqueuer]
  await processJob(approveIntent, workerDeps)

  // ── (4) Phase 2 completion is reported by the chain above ─────────────────
  section("Phase 2 complete — PR finalized")

  console.log(`→ PR#${mrIid} finalized (un-drafted, ready for human review)`)

  // ── (5) Summary ────────────────────────────────────────────────────────────
  section("SUMMARY")

  console.log("\n--- All fakeGitHub actions (in order) ---")
  githubActions.forEach((a, i) => console.log(`  ${i + 1}. ${a}`))

  console.log("\n--- Enqueued jobs ---")
  enqueuedJobs.forEach((j, i) => console.log(`  ${i + 1}. type="${j.type}"  ${JSON.stringify(j)}`))

  console.log("\n--- Memory entries written ---")
  const memEntries = memoryStore.search({ text: PRD, limit: 10 })
  if (memEntries.length === 0) {
    console.log("  (none — stubClaude produces no lesson distillation output)")
  } else {
    memEntries.forEach((e, i) => console.log(`  ${i + 1}. [${e.id}] ${e.issue}`))
  }

  console.log("\n✅  Demo complete — full pipeline exercised with zero external services.\n")
}

main().catch((err) => {
  console.error("Demo failed:", err)
  process.exit(1)
})
