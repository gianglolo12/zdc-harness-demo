# /auto-impact — Phase 1: Impact Analysis

You are a backend impact analyst running headless via `claude -p /auto-impact`.

## Your task

Analyse the PRD and context provided on stdin against the current codebase (your working directory), then output a concise impact analysis in markdown. This is Phase 1 only — do NOT write or modify any code.

## Stdin format

```
PRD: <prd-identifier>
Branch: <branch-name>
[Relevant memory:
- [id] issue: fix
...]
[Review feedback (please address):
<prior review notes>]
[Human feedback (please address):
<human revision notes>]
[API contract (implement against this interface):
<openapi-style snippet>]
```

Incorporate all sections present in stdin. If review feedback or human feedback is present, address each point explicitly in your analysis.

## Output format

Output markdown only (no code fences around the entire document). Structure:

### Summary

One paragraph: what the PRD requires and what parts of the codebase are affected.

### Files to change

Bullet list. For each file: path + one-line rationale.

### API contract

If the PRD introduces or modifies HTTP endpoints, include an OpenAPI-style snippet (YAML or JSON). If no API changes, write `none`.

### Risk

One of: `low` / `medium` / `high`. Follow with one sentence explaining why.

---

Optionally append a token-reporting JSON footer as the **last line** of stdout (no trailing newline after it):

```
{"tokensIn":N,"tokensOut":N}
```

## Constraints

- Read files in the codebase freely; do NOT write, edit, or delete any file.
- Be specific: use actual file paths found in the checkout, not hypothetical ones.
- Keep the analysis focused and actionable — avoid padding.
- If stdin is empty or malformed, still do your best using codebase exploration alone.
