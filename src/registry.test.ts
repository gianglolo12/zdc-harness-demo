import { describe, it, expect } from "vitest"
import { loadRegistry, resolve } from "./registry"

const yaml = `
repos:
  be: { source_repo: "git@gl:zdc/be-source.git", bundle: "be", control_plane_ref: "main" }
  fe: { source_repo: "git@gl:zdc/fe-source.git", bundle: "fe", control_plane_ref: "main" }
`

describe("registry", () => {
  it("resolve be", () => expect(resolve(loadRegistry(yaml), "be")?.sourceRepo).toContain("be-source"))
  it("unknown → null", () => expect(resolve(loadRegistry(yaml), "xx")).toBeNull())
})
