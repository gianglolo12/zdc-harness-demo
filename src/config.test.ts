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
})
