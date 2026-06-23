import { describe, it, expect, vi } from "vitest"
import { GitHubClient } from "./github.js"
import type { OctokitLike, RepoRef } from "./github.js"

function makeFakeOctokit(): OctokitLike {
  return {
    pulls: {
      create: vi.fn().mockResolvedValue({ data: { number: 42 } }),
      get: vi.fn().mockResolvedValue({ data: { number: 42, title: "my PR" } }),
      update: vi.fn().mockResolvedValue({ data: {} }),
    },
    issues: {
      createComment: vi.fn().mockResolvedValue({ data: {} }),
      addLabels: vi.fn().mockResolvedValue({ data: [] }),
    },
  }
}

const REPO: RepoRef = { owner: "acme", repo: "my-repo" }

describe("GitHubClient", () => {
  describe("createDraftMR", () => {
    it("calls pulls.create with draft:true and returns {iid}", async () => {
      const octokit = makeFakeOctokit()
      const client = new GitHubClient(octokit)

      const result = await client.createDraftMR(REPO, "feature/x", "My title", "body text")

      expect(octokit.pulls.create).toHaveBeenCalledOnce()
      expect(octokit.pulls.create).toHaveBeenCalledWith({
        owner: "acme",
        repo: "my-repo",
        head: "feature/x",
        base: "main",
        title: "My title",
        body: "body text",
        draft: true,
      })
      expect(result).toEqual({ iid: 42 })
    })
  })

  describe("commentMR", () => {
    it("calls issues.createComment with correct params", async () => {
      const octokit = makeFakeOctokit()
      const client = new GitHubClient(octokit)

      await client.commentMR(REPO, 42, "hello comment")

      expect(octokit.issues.createComment).toHaveBeenCalledOnce()
      expect(octokit.issues.createComment).toHaveBeenCalledWith({
        owner: "acme",
        repo: "my-repo",
        issue_number: 42,
        body: "hello comment",
      })
    })
  })

  describe("getMR", () => {
    it("calls pulls.get with correct params", async () => {
      const octokit = makeFakeOctokit()
      const client = new GitHubClient(octokit)

      await client.getMR(REPO, 42)

      expect(octokit.pulls.get).toHaveBeenCalledOnce()
      expect(octokit.pulls.get).toHaveBeenCalledWith({
        owner: "acme",
        repo: "my-repo",
        pull_number: 42,
      })
    })
  })

  describe("finalizeMR", () => {
    it("calls pulls.update with draft:false to mark PR ready", async () => {
      const octokit = makeFakeOctokit()
      const client = new GitHubClient(octokit)

      await client.finalizeMR(REPO, 42)

      expect(octokit.pulls.update).toHaveBeenCalledOnce()
      expect(octokit.pulls.update).toHaveBeenCalledWith({
        owner: "acme",
        repo: "my-repo",
        pull_number: 42,
        draft: false,
      })
    })
  })

  describe("setLabel", () => {
    it("calls issues.addLabels with label wrapped in array", async () => {
      const octokit = makeFakeOctokit()
      const client = new GitHubClient(octokit)

      await client.setLabel(REPO, 42, "ready-for-review")

      expect(octokit.issues.addLabels).toHaveBeenCalledOnce()
      expect(octokit.issues.addLabels).toHaveBeenCalledWith({
        owner: "acme",
        repo: "my-repo",
        issue_number: 42,
        labels: ["ready-for-review"],
      })
    })
  })
})
