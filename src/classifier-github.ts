import type { Classified } from "./classifier.js"

const TAG = /\[zdc:update-(be|fe|qa)\s+([A-Za-z0-9-]+)\]/
const PROTECTED = new Set(["main", "master", "develop"])
const CMD = /^\/(approve|revise|reject|abort)\b\s*(.*)$/s

/**
 * Classify a GitHub webhook event into a Classified job intent.
 *
 * Supported events:
 *  - "push": feature branch push with zdc tag + po/ file change → impact
 *  - "issue_comment": PR comment with /approve|/revise|/reject|/abort command
 *  - anything else → ignore
 */
export function classifyGithub(event: string, payload: any): Classified {
  if (event === "push") {
    return classifyPush(payload)
  }

  if (event === "issue_comment") {
    return classifyIssueComment(payload)
  }

  return { type: "ignore", reason: `unhandled event: ${event}` }
}

function classifyPush(payload: any): Classified {
  const ref = String(payload.ref ?? "").replace("refs/heads/", "")

  if (PROTECTED.has(ref)) return { type: "ignore", reason: "protected branch" }

  const commits: any[] = payload.commits ?? []
  if (commits.length === 0) return { type: "ignore", reason: "no commits" }

  // Scan ALL commits for the zdc tag and a po/ file change (spec: "any commit").
  for (const c of commits) {
    const m = TAG.exec(c.message ?? "")
    if (!m) continue

    const files = [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])]
    if (!files.some((f: string) => f.startsWith("po/"))) continue

    return { type: "impact", target: m[1], prd: m[2], ref }
  }

  return { type: "ignore", reason: "no zdc tag" }
}

function classifyIssueComment(payload: any): Classified {
  // Only handle "created" action
  if (payload.action !== "created") {
    return { type: "ignore", reason: "non-created action" }
  }

  // Only handle comments on PRs (pull_request key must exist on the issue)
  if (!payload.issue?.pull_request) {
    return { type: "ignore", reason: "comment on non-PR issue" }
  }

  const mrIid: number = payload.issue.number
  const body: string = (payload.comment?.body ?? "").trim()

  const m = CMD.exec(body)
  if (!m) return { type: "ignore", reason: "plain comment" }

  const cmd = m[1] as "approve" | "revise" | "reject" | "abort"
  const feedback = (m[2] ?? "").trim()

  if (cmd === "revise") return { type: "revise", mrIid, feedback }
  return { type: cmd, mrIid }
}
