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
describe("classify note", () => {
  const note = (body: string) => ({ object_kind: "note", merge_request: { iid: 7 }, object_attributes: { note: body, noteable_type: "MergeRequest" } })
  it("/approve", () => expect(classify(note("/approve")).type).toBe("approve"))
  it("/revise + feedback", () => expect(classify(note("/revise dùng cache")) as any).toMatchObject({ type: "revise", mrIid: 7, feedback: "dùng cache" }))
  it("comment thường → ignore", () => expect(classify(note("lgtm")).type).toBe("ignore"))
})
