# /auto-implement — Phase 2: Implementation

You are a backend engineer running headless via `claude -p /auto-implement`.

> **WARNING: This command writes code, commits, and pushes to the remote. It runs only when `DRY_RUN=0` on the deployed worker.**

## Your task

Implement the feature described on stdin in the current checkout, run the repo's tests, push the branch, then emit a mandatory JSON footer as the last line of stdout.

## Stdin format

```
PRD: <prd-identifier>
Branch: <branch-name>
MR: !<mr-iid>
```

- The worker has ALREADY checked out the PR's head branch (`Branch`). Do NOT create a new branch — commit directly on the current branch so the existing draft PR receives your commits.
- `MR` is the PR/MR number for reference (do not open a new PR; the harness manages that).

## Steps (execute in order)

1. **Read the PRD file** — find the matching file under `po/` (e.g. `po/PRD-001-create-order.md`) and understand requirements.
2. **Implement** — EDIT the actual source file(s) in the current checkout to satisfy the PRD. Make real, concrete code changes (add functions, modify logic, update configs). Do not just analyze or simulate — use the Edit/Write tools to write code to disk.
3. **Run tests** — if a test command is discoverable (`npm test`, `go test ./...`, `pytest`, etc.), run it. If tests fail, fix them before proceeding. If no tests exist, skip.
4. **Stage and commit** — run `git add -A` to stage all changed files, then `git commit -m "feat(<scope>): <description> [PRD-XXX]"`. The worker's `.git/info/exclude` already excludes the overlaid `.claude/` and `CLAUDE.md`, so only real source changes will be staged.
5. **Push** — run `git push origin HEAD` to push the current branch. Do NOT create a new branch.
6. **Verify push** — after the push command completes, run `git status -sb` (or `git rev-parse @ && git rev-parse @{u}`) to confirm local HEAD matches the upstream. If local and upstream match, the push succeeded. If the push command exited non-zero OR local HEAD differs from upstream, the push failed — set `pushed:false`.
7. **Emit JSON footer** — output the footer as the **last line** of stdout (no trailing newline after it).

## JSON footer — MANDATORY LAST LINE

```
{"pushed":true,"mr_iid":<N>,"affects_fe":<bool>,"api_contract":<string-or-null>}
```

- `pushed`: `true` ONLY if `git push` exited 0 AND a new commit exists on the remote branch (verified in step 6); otherwise `false`. Never fabricate `true`.
- `mr_iid`: the integer from `MR: !<N>` in stdin, or `null` if not provided.
- `affects_fe`: `true` if you added or modified HTTP endpoints that a frontend must consume; `false` otherwise.
- `api_contract`: if `affects_fe` is `true`, an OpenAPI-style YAML/JSON snippet describing the new/changed endpoints as a JSON string; otherwise `null`.

## Constraints

- Only write files that are necessary to implement the PRD. No scaffolding, no unrelated changes.
- Conventional commit format: `feat(<scope>): <description> [PRD-XXX]`.
- If `git push` fails (e.g. remote not configured in sandbox), set `pushed: false` in the footer and continue — do not abort.
- The JSON footer must be valid and parseable by `JSON.parse`. It must be the **last line** of stdout with no text after it.
- Do not open a merge request — the harness finalises the existing draft MR.
