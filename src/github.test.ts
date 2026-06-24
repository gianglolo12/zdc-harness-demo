import { describe, it, expect, vi } from "vitest"
import { GitHubClient } from "./github.js"
import type { OctokitLike, RepoRef } from "./github.js"

function makeFakeOctokit(): OctokitLike {
  return {
    pulls: {
      create: vi.fn().mockResolvedValue({ data: { number: 42 } }),
      get: vi.fn().mockResolvedValue({ data: { number: 42, node_id: "PR_node1", title: "my PR" } }),
      update: vi.fn().mockResolvedValue({ data: {} }),
    },
    issues: {
      createComment: vi.fn().mockResolvedValue({ data: {} }),
      addLabels: vi.fn().mockResolvedValue({ data: [] }),
      update: vi.fn().mockResolvedValue({ data: {} }),
    },
    graphql: vi.fn().mockResolvedValue({}),
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
    it("fetches node_id then calls graphql markPullRequestReadyForReview", async () => {
      const octokit = makeFakeOctokit()
      const client = new GitHubClient(octokit)

      await client.finalizeMR(REPO, 42)

      // Must first fetch the PR to get node_id
      expect(octokit.pulls.get).toHaveBeenCalledOnce()
      expect(octokit.pulls.get).toHaveBeenCalledWith({
        owner: "acme",
        repo: "my-repo",
        pull_number: 42,
      })

      // Must call GraphQL mutation with the node_id
      expect(octokit.graphql).toHaveBeenCalledOnce()
      const [query, vars] = (octokit.graphql as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(query).toContain("markPullRequestReadyForReview")
      expect(vars).toEqual({ id: "PR_node1" })

      // REST fallback still called (no-op for draft but keeps compat)
      expect(octokit.pulls.update).toHaveBeenCalledOnce()
      expect(octokit.pulls.update).toHaveBeenCalledWith({
        owner: "acme",
        repo: "my-repo",
        pull_number: 42,
        draft: false,
      })
    })

    it("skips graphql if octokit.graphql is not a function", async () => {
      const octokit = makeFakeOctokit()
      delete (octokit as Partial<OctokitLike>).graphql
      const client = new GitHubClient(octokit)

      // Should not throw even without graphql
      await expect(client.finalizeMR(REPO, 42)).resolves.not.toThrow()
      expect(octokit.pulls.update).toHaveBeenCalledOnce()
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

  describe("closeIssue", () => {
    it("calls issues.update with state closed", async () => {
      const octokit = makeFakeOctokit()
      const client = new GitHubClient(octokit)

      await client.closeIssue(REPO, 7)

      expect(octokit.issues.update).toHaveBeenCalledOnce()
      expect(octokit.issues.update).toHaveBeenCalledWith({
        owner: "acme",
        repo: "my-repo",
        issue_number: 7,
        state: "closed",
      })
    })
  })
})
