import { z } from "zod"

// Base fields always required
const baseSchema = z.object({
  GIT_PROVIDER: z.enum(["gitlab", "github"]).default("gitlab"),
  WEBHOOK_SECRET: z.string().min(1),
  REDIS_URL: z.string().min(1),
  DRY_RUN: z.string().optional(),
  // Gitlab fields — optional at raw schema level; conditional check via superRefine
  GITLAB_TOKEN: z.string().min(1).optional(),
  GITLAB_URL: z.string().url().optional(),
  // GitHub fields — optional at raw schema level; conditional check via superRefine
  GITHUB_TOKEN: z.string().min(1).optional(),
  GITHUB_OWNER: z.string().min(1).optional(),
  GITHUB_REPO: z.string().min(1).optional(),
})

const schema = baseSchema.superRefine((data, ctx) => {
  if (data.GIT_PROVIDER === "gitlab") {
    if (!data.GITLAB_TOKEN) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["GITLAB_TOKEN"], message: "GITLAB_TOKEN required for gitlab provider" })
    }
    if (!data.GITLAB_URL) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["GITLAB_URL"], message: "GITLAB_URL required for gitlab provider" })
    }
  }
  if (data.GIT_PROVIDER === "github") {
    if (!data.GITHUB_TOKEN) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["GITHUB_TOKEN"], message: "GITHUB_TOKEN required for github provider" })
    }
    if (!data.GITHUB_OWNER) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["GITHUB_OWNER"], message: "GITHUB_OWNER required for github provider" })
    }
    if (!data.GITHUB_REPO) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["GITHUB_REPO"], message: "GITHUB_REPO required for github provider" })
    }
  }
})

export interface Config {
  gitProvider: "gitlab" | "github"
  webhookSecret: string
  redisUrl: string
  dryRun: boolean
  // Present when gitProvider === "gitlab"
  gitlabToken?: string
  gitlabUrl?: string
  // Present when gitProvider === "github"
  github?: { token: string; owner: string; repo: string }
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const p = schema.parse(env)
  const base: Config = {
    gitProvider: p.GIT_PROVIDER,
    webhookSecret: p.WEBHOOK_SECRET,
    redisUrl: p.REDIS_URL,
    dryRun: p.DRY_RUN === "1",
  }
  if (p.GIT_PROVIDER === "gitlab") {
    base.gitlabToken = p.GITLAB_TOKEN!
    base.gitlabUrl = p.GITLAB_URL!
  }
  if (p.GIT_PROVIDER === "github") {
    base.github = { token: p.GITHUB_TOKEN!, owner: p.GITHUB_OWNER!, repo: p.GITHUB_REPO! }
  }
  return base
}
