import { describe, it, expect } from "vitest"
import { classifyGithub } from "./classifier-github.js"

// Helper: build a valid GitHub push payload
function pushPayload(ref: string, commits: any[]) {
  return { ref, commits }
}

// Helper: build a valid GitHub issue_comment payload (on a PR)
function prCommentPayload(body: string, issueNumber: number, action = "created") {
  return {
    action,
    issue: {
      number: issueNumber,
      pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/42" },
    },
    comment: { body },
  }
}

// Helper: issue comment on a plain issue (no pull_request key)
function issueCommentPayload(body: string, issueNumber: number) {
  return {
    action: "created",
    issue: { number: issueNumber },
    comment: { body },
  }
}

describe("classifyGithub — push event", () => {
  it("valid push → impact", () => {
    const payload = pushPayload("refs/heads/feature/demo", [
      {
        message: "[zdc:update-be myPRD] initial",
        added: ["po/be.json"],
        modified: [],
        removed: [],
      },
    ])
    expect(classifyGithub("push", payload)).toEqual({
      type: "impact",
      target: "be",
      prd: "myPRD",
      ref: "feature/demo",
    })
  })

  it("main branch → ignore", () => {
    const payload = pushPayload("refs/heads/main", [
      {
        message: "[zdc:update-be myPRD] fix",
        added: ["po/be.json"],
        modified: [],
        removed: [],
      },
    ])
    expect(classifyGithub("push", payload)).toMatchObject({ type: "ignore" })
  })

  it("master branch → ignore", () => {
    const payload = pushPayload("refs/heads/master", [
      {
        message: "[zdc:update-fe myPRD]",
        added: ["po/fe.json"],
        modified: [],
        removed: [],
      },
    ])
    expect(classifyGithub("push", payload)).toMatchObject({ type: "ignore" })
  })

  it("develop branch → ignore", () => {
    const payload = pushPayload("refs/heads/develop", [
      {
        message: "[zdc:update-qa myPRD]",
        added: ["po/qa.json"],
        modified: [],
        removed: [],
      },
    ])
    expect(classifyGithub("push", payload)).toMatchObject({ type: "ignore" })
  })

  it("no zdc tag in commit message → ignore", () => {
    const payload = pushPayload("refs/heads/feature/no-tag", [
      { message: "plain commit", added: ["po/be.json"], modified: [], removed: [] },
    ])
    expect(classifyGithub("push", payload)).toMatchObject({ type: "ignore" })
  })

  it("tag present but no po/ file change → ignore", () => {
    const payload = pushPayload("refs/heads/feature/x", [
      {
        message: "[zdc:update-be myPRD]",
        added: ["src/index.ts"],
        modified: [],
        removed: [],
      },
    ])
    expect(classifyGithub("push", payload)).toMatchObject({ type: "ignore" })
  })

  it("tag in second commit, po/ in second commit → impact (scan ALL commits)", () => {
    const payload = pushPayload("refs/heads/feature/multi", [
      { message: "chore: bump", added: [], modified: [], removed: [] },
      {
        message: "[zdc:update-fe FEAT-123]",
        added: [],
        modified: ["po/fe.yaml"],
        removed: [],
      },
    ])
    expect(classifyGithub("push", payload)).toEqual({
      type: "impact",
      target: "fe",
      prd: "FEAT-123",
      ref: "feature/multi",
    })
  })

  it("no commits array → ignore", () => {
    const payload = { ref: "refs/heads/feature/x" }
    expect(classifyGithub("push", payload)).toMatchObject({ type: "ignore" })
  })

  it("po/ file in removed[] counts", () => {
    const payload = pushPayload("refs/heads/feature/del", [
      {
        message: "[zdc:update-qa JIRA-99]",
        added: [],
        modified: [],
        removed: ["po/qa.json"],
      },
    ])
    expect(classifyGithub("push", payload)).toEqual({
      type: "impact",
      target: "qa",
      prd: "JIRA-99",
      ref: "feature/del",
    })
  })
})

describe("classifyGithub — issue_comment event on PR", () => {
  it("/approve → approve with mrIid", () => {
    expect(classifyGithub("issue_comment", prCommentPayload("/approve", 42))).toEqual({
      type: "approve",
      mrIid: 42,
    })
  })

  it("/reject → reject with mrIid", () => {
    expect(classifyGithub("issue_comment", prCommentPayload("/reject", 7))).toEqual({
      type: "reject",
      mrIid: 7,
    })
  })

  it("/abort → abort with mrIid", () => {
    expect(classifyGithub("issue_comment", prCommentPayload("/abort", 3))).toEqual({
      type: "abort",
      mrIid: 3,
    })
  })

  it("/revise with feedback → revise + feedback", () => {
    expect(
      classifyGithub("issue_comment", prCommentPayload("/revise please add error handling", 10))
    ).toEqual({ type: "revise", mrIid: 10, feedback: "please add error handling" })
  })

  it("/revise with no feedback → revise + empty feedback", () => {
    expect(classifyGithub("issue_comment", prCommentPayload("/revise", 5))).toEqual({
      type: "revise",
      mrIid: 5,
      feedback: "",
    })
  })

  it("plain comment → ignore", () => {
    expect(
      classifyGithub("issue_comment", prCommentPayload("looks good to me", 42))
    ).toMatchObject({ type: "ignore" })
  })

  it("action !== created → ignore", () => {
    const payload = {
      action: "edited",
      issue: {
        number: 42,
        pull_request: { url: "https://..." },
      },
      comment: { body: "/approve" },
    }
    expect(classifyGithub("issue_comment", payload)).toMatchObject({ type: "ignore" })
  })

  it("comment on plain issue (no pull_request) → ignore", () => {
    expect(
      classifyGithub("issue_comment", issueCommentPayload("/approve", 99))
    ).toMatchObject({ type: "ignore" })
  })
})

describe("classifyGithub — unknown event", () => {
  it("unknown event → ignore", () => {
    expect(classifyGithub("ping", {})).toMatchObject({ type: "ignore" })
  })

  it("pull_request event → ignore", () => {
    expect(classifyGithub("pull_request", { action: "opened" })).toMatchObject({ type: "ignore" })
  })
})
