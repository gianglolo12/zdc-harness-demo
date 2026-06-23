import { describe, it, expect, vi } from "vitest"
import { GitLabClient } from "./gitlab.js"

describe("GitLabClient", () => {
  it("createDraftMR prepends 'Draft: ' to title", async () => {
    const api = {
      MergeRequests: { create: vi.fn().mockResolvedValue({ iid: 5 }) },
    }
    const gl = new GitLabClient(api as any)
    await gl.createDraftMR(1, "feature/x", "Solution PRD-1", "body")
    expect(api.MergeRequests.create).toHaveBeenCalledWith(
      1,
      "feature/x",
      expect.any(String),
      expect.stringContaining("Draft: Solution"),
      expect.anything(),
    )
  })

  it("commentMR calls MergeRequestNotes.create", async () => {
    const api = {
      MergeRequestNotes: { create: vi.fn().mockResolvedValue({ id: 99 }) },
    }
    const gl = new GitLabClient(api as any)
    await gl.commentMR(2, 7, "hello comment")
    expect(api.MergeRequestNotes.create).toHaveBeenCalledWith(2, 7, "hello comment")
  })

  it("getMR calls MergeRequests.show and returns result", async () => {
    const mrData = { iid: 3, title: "Draft: Fix", state: "opened" }
    const api = {
      MergeRequests: { show: vi.fn().mockResolvedValue(mrData) },
    }
    const gl = new GitLabClient(api as any)
    const result = await gl.getMR(5, 3)
    expect(api.MergeRequests.show).toHaveBeenCalledWith(5, 3)
    expect(result).toEqual(mrData)
  })
})
