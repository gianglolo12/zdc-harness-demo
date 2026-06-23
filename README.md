# zdc-harness

Event-driven development harness for the ZDC platform. Receives GitLab webhooks, orchestrates AI agent bundles against source repos, and manages the full impact → review → implement lifecycle via a queue/worker architecture.

---

## Architecture

The harness is the **control plane** — it never contains source code. It sits between GitLab events and AI agents, wiring them together.

```
GitLab (push / MR note)
        │
        ▼  POST /webhook
┌───────────────────┐
│  Fastify server   │  verifyToken → classify → enqueue
└───────────────────┘
        │
        ▼  BullMQ (Redis)
┌───────────────────┐
│    Worker pool    │  processJob → pipeline stage
└───────────────────┘
        │
   ┌────┴────┐
   ▼         ▼
Phase 1   Phase 2           (human gate between them)
impact    implement
   │         │
   └────┬────┘
        ▼
  claude -p /auto-*
  (in overlaid checkout)
        │
        ▼
  GitLab MR (draft → finalized)
```

### Components

| Component | File | Role |
|---|---|---|
| Webhook server | `src/server.ts` | Receive + verify + classify → enqueue |
| Classifier | `src/classifier.ts` | Parse push/note event → job intent |
| Queue | `src/queue.ts` | BullMQ wrapper; `Enqueuer` interface |
| Worker | `src/worker.ts` | Consume jobs; dispatch to pipeline stages |
| Phase 1 | `src/pipeline/phase1-impact.ts` | checkout → overlay → `/auto-impact` → second-opinion → draft MR |
| Second opinion | `src/pipeline/second-opinion.ts` | Run `/auto-review-solution`; verdict pass/fail |
| Human gate | `src/pipeline/human-gate.ts` | Handle `/approve`, `/revise`, `/reject`, `/abort` from MR notes |
| Phase 2 | `src/pipeline/phase2-implement.ts` | checkout → overlay → `/auto-implement` → finalize MR → memory |
| GitLab client | `src/gitlab.ts` | MR create/comment/finalize via `@gitbeaker/rest` |
| Claude runner | `src/claude-runner.ts` | Spawn `claude -p <command>` in a source checkout |
| Overlay engine | `src/overlay.ts` | Merge shared + bundle config into checkout (ephemeral) |
| Registry | `src/registry.ts` | Map target name → source repo + agent bundle |
| State store | `src/state-store.ts` | Per-MR job state (Redis-backed; in-memory for tests) |
| Memory store | `src/memory-store.ts` | FTS5 (SQLite) lessons-learned DB |
| Kill-switch | `src/kill-switch.ts` | Pause all workers via env flag |

### Control-plane topology

```
zdc-harness/          ← this repo (harness only, no source code)
zc-docs/              ← control-plane repo
  ├── .claude/        ← shared agent config (skills, hooks, CLAUDE.md)
  ├── be/             ← BE agent bundle (manifest + CLAUDE.md override + skills)
  ├── fe/             ← FE agent bundle
  └── po/             ← PRD source files (trigger on push here)

be-source/            ← source repo (code only, no .claude/)
fe-source/            ← source repo
```

At runtime the harness overlays `zc-docs/.claude/` + `zc-docs/<bundle>/` into the source checkout (ephemeral, gitignored). The source repo never permanently contains `.claude/`.

---

## Environment variables

Copy `.env.example` → `.env` and fill in values.

**Provider selection:** set `GIT_PROVIDER=gitlab` (default) for GitLab or `GIT_PROVIDER=github` for GitHub.

| Variable | Required | Description |
|---|---|---|
| `GIT_PROVIDER` | No | `gitlab` (default) \| `github` — selects the Git provider |
| `GITLAB_TOKEN` | Yes (gitlab) | GitLab personal/project access token (api scope) |
| `GITLAB_URL` | Yes (gitlab) | GitLab base URL, e.g. `https://gitlab.example.com` |
| `GITHUB_TOKEN` | Yes (github) | GitHub personal access token (repo scope) |
| `GITHUB_OWNER` | Yes (github) | GitHub repo owner (user or org) |
| `GITHUB_REPO` | Yes (github) | GitHub repo name |
| `WEBHOOK_SECRET` | Yes | Webhook secret — `x-gitlab-token` (GitLab) or HMAC key for `X-Hub-Signature-256` (GitHub) |
| `REDIS_URL` | Yes | Redis connection URL, e.g. `redis://localhost:6379` |
| `DRY_RUN` | No | Set `1` to stop after Phase 1 (draft MR only, no code generation) |
| `HARNESS_PAUSED` | No | Set `1` to hold all incoming jobs without processing |

---

## How to run

### Development

```bash
# Install dependencies
npm install

# Start Redis (Docker example)
docker run -d -p 6379:6379 redis:7

# Copy and fill env
cp .env.example .env
# Edit .env ...

# Start server (ts-node / tsx)
npx tsx src/server.ts

# Start worker (separate process)
npx tsx src/worker.ts
```

### Tests

```bash
# Run all tests (no Redis/GitLab/Claude required)
npm test

# Watch mode
npm test -- --watch

# Specific file
npm test -- tests/e2e.test.ts
```

### Production

```bash
# Build
npm run build

# Run (ensure REDIS_URL / GITLAB_TOKEN / WEBHOOK_SECRET are set)
node dist/server.js &
node dist/worker.js &
```

---

## Adding a repo to `registry.yaml`

`registry.yaml` lives at the harness root. Add an entry under `repos:`:

```yaml
repos:
  be:
    source_repo: "git@gitlab.example.com:org/be-source.git"
    bundle: "be"
    control_plane_ref: "main"

  fe:
    source_repo: "git@gitlab.example.com:org/fe-source.git"
    bundle: "fe"
    control_plane_ref: "main"

  # Add a new target:
  infra:
    source_repo: "git@gitlab.example.com:org/infra-source.git"
    bundle: "infra"
    control_plane_ref: "main"
```

The `bundle` value maps to a directory inside the control-plane repo (`zc-docs/infra/`). Create that bundle (see below) before pushing the registry change.

To trigger for the new target, push a commit to the control-plane repo that:
1. Contains the tag `[zdc:update-infra <PRD-ID>]` in the commit message.
2. Adds or modifies a file under `po/` in the same commit.

---

## How to author an agent bundle

An agent bundle is a directory in the control-plane repo (e.g. `zc-docs/be/`). The harness overlays it into the source checkout before running any `claude -p` command.

### Minimum bundle layout

```
zc-docs/be/
├── CLAUDE.md             ← stack-specific instructions (overrides shared .claude/CLAUDE.md)
├── manifest.yaml         ← declares the three agent commands
└── skills/               ← optional: skill files for this stack
    └── *.md
```

### `manifest.yaml` schema

```yaml
bundle: be          # must match the key in registry.yaml
description: "Backend (NestJS/TypeScript) agent bundle"

commands:
  /auto-impact:
    description: "Analyse PRD change impact on this repo"
    output: solution_json    # see contract below

  /auto-implement:
    description: "Implement the approved solution and push to MR branch"
    output: footer_json      # see contract below

  /auto-review-solution:
    description: "Adversarially review a proposed solution"
    output: verdict_json     # see contract below
```

### JSON output contracts (harness parses these from stdout)

#### `/auto-impact` → solution text (no strict JSON required)
The harness captures the full stdout as the solution body and posts it to the draft MR description. Optionally include `memory_refs` for context, but any plain text is valid.

#### `/auto-review-solution` → verdict JSON (last JSON object in stdout)
```json
{
  "verdict": "pass",   // "pass" | "fail"
  "notes": "..."       // feedback string; empty string on pass
}
```

#### `/auto-implement` → footer JSON (last JSON object in stdout)
```json
{
  "pushed": true,
  "mr_iid": 42,
  "affects_fe": false,       // true → harness enqueues an fe impact job
  "api_contract": "{}"       // serialized contract string, passed to fe impact job
}
```

If the agent does not emit a valid JSON footer, the harness logs a warning and continues (no crash — MR is still finalized).

### `CLAUDE.md` tips

- Extend, not replace, the shared `zc-docs/.claude/CLAUDE.md`.
- Keep stack-specific conventions (naming, frameworks, test runner) here.
- Reference the three commands explicitly so the agent knows what to respond to.

---

## Dry-run mode

Set `DRY_RUN=1` to run Phase 1 only. The harness creates the draft MR with the impact analysis but never enqueues Phase 2. The MR gets a comment:

> **dry-run: solution only** — Phase 2 (code generation) is disabled in dry-run mode.

Useful for validating agent output quality before enabling auto-implement.

---

## Kill-switch

Set `HARNESS_PAUSED=1` at runtime to hold all jobs without processing. Workers log `[worker] kill-switch active — job held: <type>` and exit the job handler cleanly. Jobs remain in the queue and resume when the flag is cleared.
