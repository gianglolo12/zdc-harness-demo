import { describe, it, expect } from "vitest"
import { loadConfig } from "./config.js"

describe("loadConfig", () => {
  it("parse valid env", () => {
    const c = loadConfig({
      GITLAB_TOKEN: "t",
      WEBHOOK_SECRET: "s",
      REDIS_URL: "redis://x",
      GITLAB_URL: "https://gl",
    })
    expect(c.gitlabToken).toBe("t")
    expect(c.webhookSecret).toBe("s")
    expect(c.redisUrl).toBe("redis://x")
    expect(c.gitlabUrl).toBe("https://gl")
    expect(c.dryRun).toBe(false)
  })

  it("dryRun=true when DRY_RUN=1", () => {
    const c = loadConfig({
      GITLAB_TOKEN: "t",
      WEBHOOK_SECRET: "s",
      REDIS_URL: "redis://x",
      GITLAB_URL: "https://gl",
      DRY_RUN: "1",
    })
    expect(c.dryRun).toBe(true)
  })

  it("throw when missing required fields", () => {
    expect(() => loadConfig({})).toThrow()
  })

  it("throw when GITLAB_URL is not a valid URL", () => {
    expect(() =>
      loadConfig({
        GITLAB_TOKEN: "t",
        WEBHOOK_SECRET: "s",
        REDIS_URL: "redis://x",
        GITLAB_URL: "not-a-url",
      })
    ).toThrow()
  })

  it("gitlab provider explicit still works", () => {
    const c = loadConfig({
      GIT_PROVIDER: "gitlab",
      GITLAB_TOKEN: "t",
      WEBHOOK_SECRET: "s",
      REDIS_URL: "redis://x",
      GITLAB_URL: "https://gl",
    })
    expect(c.gitProvider).toBe("gitlab")
    expect(c.gitlabToken).toBe("t")
  })

  it("github provider valid", () => {
    const c = loadConfig({
      GIT_PROVIDER: "github",
      GITHUB_TOKEN: "gh-tok",
      GITHUB_OWNER: "myorg",
      GITHUB_REPO: "myrepo",
      WEBHOOK_SECRET: "s",
      REDIS_URL: "redis://x",
    })
    expect(c.gitProvider).toBe("github")
    expect(c.github).toEqual({ token: "gh-tok", owner: "myorg", repo: "myrepo" })
    expect(c.gitlabToken).toBeUndefined()
    expect(c.gitlabUrl).toBeUndefined()
  })

  it("github provider missing GITHUB_TOKEN throws", () => {
    expect(() =>
      loadConfig({
        GIT_PROVIDER: "github",
        GITHUB_OWNER: "myorg",
        GITHUB_REPO: "myrepo",
        WEBHOOK_SECRET: "s",
        REDIS_URL: "redis://x",
      })
    ).toThrow()
  })

  it("github provider missing GITHUB_OWNER throws", () => {
    expect(() =>
      loadConfig({
        GIT_PROVIDER: "github",
        GITHUB_TOKEN: "gh-tok",
        GITHUB_REPO: "myrepo",
        WEBHOOK_SECRET: "s",
        REDIS_URL: "redis://x",
      })
    ).toThrow()
  })

  it("github provider missing GITHUB_REPO throws", () => {
    expect(() =>
      loadConfig({
        GIT_PROVIDER: "github",
        GITHUB_TOKEN: "gh-tok",
        GITHUB_OWNER: "myorg",
        WEBHOOK_SECRET: "s",
        REDIS_URL: "redis://x",
      })
    ).toThrow()
  })

  it("gitlab provider (default) missing GITLAB_TOKEN throws", () => {
    expect(() =>
      loadConfig({
        WEBHOOK_SECRET: "s",
        REDIS_URL: "redis://x",
        GITLAB_URL: "https://gl",
      })
    ).toThrow()
  })
})
