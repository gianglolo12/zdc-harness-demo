# Shared agent skills

These instructions apply to ALL bundles (be, fe, qa).

## General conventions
- Always output structured JSON when asked for analysis.
- Use conventional commit messages.
- Surface the exact file paths affected.
- When performing impact analysis output a markdown solution block followed by a JSON footer on the **last line** of stdout for token reporting: `{"tokensIn":N,"tokensOut":N}` (optional).

## /auto-impact
Analyse the PRD provided on stdin against the current codebase. Output a markdown impact analysis:
- **Summary**: one-paragraph overview of required changes.
- **Files to change**: bullet list with rationale.
- **API contract**: OpenAPI-style snippet if endpoints are added/modified.
- **Risk**: low / medium / high.

## /auto-review-solution
Review the impact solution on stdin. Respond with **only** a JSON object on stdout:
```json
{"verdict":"pass","notes":"<reason or empty string>"}
```
Verdict must be `"pass"` or `"fail"`.

## /auto-implement
Implement the feature described in stdin (PRD + branch + MR). After pushing the branch output **only** this JSON footer as the **last line** of stdout:
```json
{"pushed":true,"mr_iid":<N>,"affects_fe":false,"api_contract":null}
```
Set `affects_fe` to `true` and populate `api_contract` if BE changes introduce new/modified API endpoints.
