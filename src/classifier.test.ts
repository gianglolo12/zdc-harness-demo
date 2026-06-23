import { describe, it, expect } from "vitest"
import { classify } from "./classifier"
const push = (over: any = {}) => ({ object_kind: "push", ref: "refs/heads/feature/x",
  commits: [{ message: "[zdc:update-be PRD-123] add", added: ["po/G2/doc.prd.md"], modified: [], removed: [] }], ...over })
describe("classify push", () => {
  it("feature + tag + po/** → impact", () => {
    const r = classify(push()) as any
    expect(r).toMatchObject({ type: "impact", target: "be", prd: "PRD-123", ref: "feature/x" })
  })
  it("main branch → ignore", () => expect(classify(push({ ref: "refs/heads/main" })).type).toBe("ignore"))
  it("không tag → ignore", () => expect(classify(push({ commits: [{ message: "fix", added: ["po/a.md"], modified: [], removed: [] }] })).type).toBe("ignore"))
  it("chỉ đổi be/ → ignore", () => expect(classify(push({ commits: [{ message: "[zdc:update-be PRD-1] x", added: ["be/skills/y.md"], modified: [], removed: [] }] })).type).toBe("ignore"))
})
describe("classify push — M3 scan all commits", () => {
  it("zdc tag in second commit (not commits[0]) → impact", () => {
    const r = classify({
      object_kind: "push",
      ref: "refs/heads/feature/y",
      commits: [
        // first commit: no tag
        { message: "chore: bump version", added: [], modified: [], removed: [] },
        // second commit: tag + po/ file
        { message: "[zdc:update-fe PRD-456] impact", added: ["po/G1/spec.prd.md"], modified: [], removed: [] },
      ],
    }) as any
    expect(r).toMatchObject({ type: "impact", target: "fe", prd: "PRD-456", ref: "feature/y" })
  })

  it("tag present but po/ file only in a different commit → ignore", () => {
    // tag in commit[0] but po/ file in commit[1] — no single commit has both
    const r = classify({
      object_kind: "push",
      ref: "refs/heads/feature/z",
      commits: [
        { message: "[zdc:update-be PRD-1] x", added: ["be/foo.ts"], modified: [], removed: [] },
        { message: "add prd", added: ["po/G1/doc.prd.md"], modified: [], removed: [] },
      ],
    })
    expect(r.type).toBe("ignore")
  })
})

describe("classify note", () => {
  const note = (body: string, mr?: any) => ({
    object_kind: "note",
    merge_request: mr,
    object_attributes: { note: body, noteable_type: "MergeRequest" },
  })
  it("/approve", () => expect(classify(note("/approve", { iid: 7 })).type).toBe("approve"))
  it("/revise + feedback", () => expect(classify(note("/revise dùng cache", { iid: 7 })) as any).toMatchObject({ type: "revise", mrIid: 7, feedback: "dùng cache" }))
  it("comment thường → ignore", () => expect(classify(note("lgtm", { iid: 7 })).type).toBe("ignore"))
  it("M4: note with no merge_request.iid → ignore (not enqueued with undefined mrIid)", () => {
    // merge_request object present but iid is absent
    expect(classify(note("/approve", {})).type).toBe("ignore")
  })
  it("M4: note with no merge_request at all → ignore", () => {
    expect(classify(note("/approve", undefined)).type).toBe("ignore")
  })
})
