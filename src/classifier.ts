const TAG = /\[zdc:update-(be|fe|qa)\s+([A-Za-z0-9-]+)\]/
const PROTECTED = new Set(["main", "master", "develop"])
const CMD = /^\/(approve|revise|reject|abort)\b\s*(.*)$/s

export type ImpactJobIntent = {
  type: "impact"
  target: string
  prd: string
  ref: string
  /** Human revise feedback carried into the re-run (I1). */
  feedback?: string
  /** BE→FE API contract handed off from Phase 2 (I2). */
  api_contract?: string
}
// Phase2JobIntent is imported lazily to avoid a circular dep — we inline the shape here.
// The authoritative definition lives in ./pipeline/human-gate.ts.
type Phase2JobIntentShape = { type: "phase2"; mrIid: number; target: string; prd: string; ref: string }

export type JobIntent =
  | ImpactJobIntent
  | Phase2JobIntentShape
  | { type: "approve" | "reject" | "abort"; mrIid: number }
  | { type: "revise"; mrIid: number; feedback: string }
export type Classified = JobIntent | { type: "ignore"; reason: string }

export function classify(p: any): Classified {
  if (p.object_kind === "push") {
    const ref = String(p.ref ?? "").replace("refs/heads/", "")
    if (PROTECTED.has(ref)) return { type: "ignore", reason: "protected branch" }
    const commits: any[] = p.commits ?? []
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
  if (p.object_kind === "note" && p.object_attributes?.noteable_type === "MergeRequest") {
    const m = CMD.exec((p.object_attributes.note ?? "").trim())
    if (!m) return { type: "ignore", reason: "plain comment" }
    const mrIid = p.merge_request?.iid
    // Guard: if mrIid is missing, downstream would operate on undefined MR.
    if (mrIid == null) return { type: "ignore", reason: "note missing merge_request.iid" }
    if (m[1] === "revise") return { type: "revise", mrIid, feedback: (m[2] ?? "").trim() }
    return { type: m[1] as any, mrIid }
  }
  return { type: "ignore", reason: "unhandled event" }
}
