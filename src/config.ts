import { z } from "zod"

const schema = z.object({
  GITLAB_TOKEN: z.string().min(1),
  WEBHOOK_SECRET: z.string().min(1),
  REDIS_URL: z.string().min(1),
  GITLAB_URL: z.string().url(),
  DRY_RUN: z.string().optional(),
})

export interface Config {
  gitlabToken: string
  webhookSecret: string
  redisUrl: string
  gitlabUrl: string
  dryRun: boolean
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const p = schema.parse(env)
  return {
    gitlabToken: p.GITLAB_TOKEN,
    webhookSecret: p.WEBHOOK_SECRET,
    redisUrl: p.REDIS_URL,
    gitlabUrl: p.GITLAB_URL,
    dryRun: p.DRY_RUN === "1",
  }
}
