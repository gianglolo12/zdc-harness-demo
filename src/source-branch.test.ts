import { describe, it, expect } from "vitest"
import { sourceBranch } from "./source-branch.js"

describe("sourceBranch", () => {
  it("derives lowercased zdc-<role>-<prd>", () => {
    expect(sourceBranch("be", "G3-FB08")).toBe("zdc-be-g3-fb08")
  })

  it("replaces unsafe characters with dash", () => {
    expect(sourceBranch("BE", "PRD 006!")).toBe("zdc-be-prd-006-")
  })

  it("keeps allowed ref characters (._/-)", () => {
    expect(sourceBranch("fe", "v1.2/x")).toBe("zdc-fe-v1.2/x")
  })
})
