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
2. **Implement** — write the minimal code satisfying the PRD. Follow existing code conventions in the checkout.
3. **Run tests** — if a test command is discoverable (`npm test`, `go test ./...`, `pytest`, etc.), run it. If tests fail, fix them before proceeding. If no tests exist, skip.
4. **Commit** — stage all changes on the CURRENT branch (already the PR head), commit with a conventional commit message referencing the PRD. Do NOT create a new branch.
5. **Push** — `git push origin HEAD` (pushes the current branch; credentials are already configured by the worker).
7. **Emit JSON footer** — output the footer as the **last line** of stdout (no trailing newline after it).

## JSON footer — MANDATORY LAST LINE

```
{"pushed":true,"mr_iid":<N>,"affects_fe":<bool>,"api_contract":<string-or-null>}
```

- `pushed`: always `true` after a successful push.
- `mr_iid`: the integer from `MR: !<N>` in stdin, or `null` if not provided.
- `affects_fe`: `true` if you added or modified HTTP endpoints that a frontend must consume; `false` otherwise.
- `api_contract`: if `affects_fe` is `true`, an OpenAPI-style YAML/JSON snippet describing the new/changed endpoints as a JSON string; otherwise `null`.

## Constraints

- Only write files that are necessary to implement the PRD. No scaffolding, no unrelated changes.
- Conventional commit format: `feat(<scope>): <description> [PRD-XXX]`.
- If `git push` fails (e.g. remote not configured in sandbox), set `pushed: false` in the footer and continue — do not abort.
- The JSON footer must be valid and parseable by `JSON.parse`. It must be the **last line** of stdout with no text after it.
- Do not open a merge request — the harness finalises the existing draft MR.
