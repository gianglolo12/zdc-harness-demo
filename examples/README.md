# zdc-harness demo

A fully-local, runnable demo of the event-driven pipeline with **no external
services** — no real GitHub, no real Claude, no Redis.

## Quick start

```bash
npm run demo
# or directly:
npx tsx examples/run-demo.ts
```

No environment variables or network access required.

## What each section shows

| Section | What it proves |
|---------|---------------|
| **(1) PUSH webhook** | `classifyGithub("push", …)` parses a branch push with a `[zdc:update-be PRD-001]` commit tag and a `po/` file change → produces an `impact` `JobIntent`. |
| **(2) processJob(impact) → Phase 1** | `runPhase1` resolves the registry, runs fakeCheckout + fakeOverlay, calls `stubClaude(/auto-impact)`, gets a `pass` from `reviewSolution(/auto-review-solution)`, creates a draft PR via `fakeGitHub.createDraftMR`, and persists job state to `InMemoryStateStore`. |
| **(3) /approve comment → phase2 enqueued** | `classifyGithub("issue_comment", …)` parses a `/approve` comment → `approve` intent → `handleCommand` reads state, enqueues a `phase2` job. The in-memory enqueuer immediately routes it back through `processJob`. |
| **(4) Phase 2 complete** | `runPhase2` calls `stubClaude(/auto-implement)`, parses the JSON footer (`pushed:true`), finalises the PR via `fakeGitHub.finalizeMR`, and writes a memory entry to `SqliteMemoryStore(":memory:")`. |
| **(5) Summary** | Lists every fake-GitHub action in order and all enqueued jobs. |

## Stub inventory

| Stub | Lives in | Purpose |
|------|----------|---------|
| `stubClaude` | `examples/run-demo.ts` | Returns canned markdown for `/auto-impact`, `{"verdict":"pass"}` for `/auto-review-solution`, and a JSON footer for `/auto-implement`. |
| `fakeGitHub` | `examples/run-demo.ts` | Implements the `GitLabClient` method surface used by the pipelines (`createDraftMR`, `commentMR`, `getMR`, `finalizeMR`, `setLabel`). Records every call with a `[fakeGitHub]` prefix. |
| `fakeCheckout` | `examples/run-demo.ts` | Creates a temp dir; no git clone. |
| `fakeOverlay` | `examples/run-demo.ts` | Copies `examples/control-plane/.claude` into the temp dir; no git. |
| `inMemoryEnqueuer` | `examples/run-demo.ts` | Synchronously routes enqueued jobs back through `processJob` (guarded by `MAX_STEPS=10`). |

## Swapping stubs for real services

To run against real Claude + GitHub, replace the stubs in `run-demo.ts`:

1. **Real Claude** — replace `stubClaude` with `runClaude` from `src/claude-runner.ts`.
   Requires `claude /login` on the machine and the agent bundle installed in
   the checkout directory (the overlay step handles this in production).

2. **Real GitHub** — replace `fakeGitHub` with a `GitHubClient` instance from
   `src/github.ts` wired to a real Octokit token.  See `src/worker.ts`
   (`selectGitClient`) for how the production worker builds this.

3. **Real queue** — replace `inMemoryEnqueuer` with `bullmqEnqueuer` from
   `src/queue.js` pointed at a live Redis instance.

4. **Deployment** — see `docs/deployment-guide.md` for the full production
   setup (Docker, Redis, webhook registration).

> **Note:** This demo proves the orchestration logic is wired correctly.
> The deployed harness additionally needs `claude /login`, a real agent
> bundle mounted at `controlPlaneDir`, and a live Redis for the BullMQ queue.

## Control-plane sample files

```
examples/control-plane/
├── registry.yaml              # maps "be" target → zdc-be-demo source repo
├── .claude/
│   ├── commands/
│   │   ├── auto-impact.md         # /auto-impact slash-command (Phase 1)
│   │   ├── auto-review-solution.md # /auto-review-solution slash-command
│   │   └── auto-implement.md      # /auto-implement slash-command (Phase 2)
│   └── skills/
│       └── shared.md          # shared agent skills reference
├── be/
│   ├── manifest.json          # command → slash-command mapping for BE bundle
│   └── CLAUDE.md              # BE persona injected into the checkout root
└── po/
    └── PRD-001-create-order.md  # sample PRD used by the demo
```

## Deploying the agent bundle

This `control-plane/` directory is baked into the Docker image. On the deployed worker, set:

```
CONTROL_PLANE_DIR=/app/examples/control-plane
```

The worker overlays `examples/control-plane/be/` (CLAUDE.md, manifest.json) and
`examples/control-plane/.claude/` (commands/, skills/) into each source checkout
before invoking `claude -p /auto-impact` or `claude -p /auto-implement`.

`registry.yaml` maps the `"be"` target to the demo source repo:

```yaml
repos:
  be:
    source_repo: "https://github.com/gianglolo12/zdc-be-demo.git"
    bundle: "be"
    control_plane_ref: "main"
```
