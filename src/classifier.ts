const TAG = /\[zdc:update-(be|fe|qa)\s+([A-Za-z0-9-]+)\]/
const PROTECTED = new Set(["main", "master", "develop"])
const CMD = /^\/(approve|revise|reject|abort)\b\s*(.*)$/s

export type JobIntent =
  | { type: "impact"; target: string; prd: string; ref: string }
  | { type: "approve" | "reject" | "abort"; mrIid: number }
  | { type: "revise"; mrIid: number; feedback: string }
export type Classified = JobIntent | { type: "ignore"; reason: string }

export function classify(p: any): Classified {
  if (p.object_kind === "push") {
    const ref = String(p.ref ?? "").replace("refs/heads/", "")
    if (PROTECTED.has(ref)) return { type: "ignore", reason: "protected branch" }
    const c = p.commits?.[0]
    if (!c) return { type: "ignore", reason: "no commits" }
    const m = TAG.exec(c.message ?? "")
    if (!m) return { type: "ignore", reason: "no zdc tag" }
    const files = [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])]
    if (!files.some((f: string) => f.startsWith("po/"))) return { type: "ignore", reason: "no PRD change" }
    return { type: "impact", target: m[1], prd: m[2], ref }
  }
  if (p.object_kind === "note" && p.object_attributes?.noteable_type === "MergeRequest") {
    const m = CMD.exec((p.object_attributes.note ?? "").trim())
    if (!m) return { type: "ignore", reason: "plain comment" }
    const mrIid = p.merge_request?.iid
    if (m[1] === "revise") return { type: "revise", mrIid, feedback: (m[2] ?? "").trim() }
    return { type: m[1] as any, mrIid }
  }
  return { type: "ignore", reason: "unhandled event" }
}
