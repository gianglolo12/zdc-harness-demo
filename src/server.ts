import Fastify from "fastify"
import { verifyToken, verifyGithubSignature } from "./verify-signature.js"
import type { Classified, JobIntent } from "./classifier.js"
import type { Enqueuer } from "./queue.js"

// ─── Injected dependencies interface ─────────────────────────────────────────

export type ServerDeps =
  | {
      secret: string
      gitProvider?: "gitlab"
      classify: (body: unknown) => Classified
      enqueuer: Enqueuer
    }
  | {
      secret: string
      gitProvider: "github"
      classifyGithub: (event: string, body: unknown) => Classified
      enqueuer: Enqueuer
    }

// ─── Types that trigger an enqueue ───────────────────────────────────────────

const ACTIONABLE_TYPES = new Set(["impact", "approve", "revise", "reject", "abort"])

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Builds a Fastify instance with POST /webhook wired up.
 * Supports both GitLab (static token) and GitHub (HMAC-SHA256) verification.
 * All deps are injected so tests never need a live Redis/GitLab/GitHub.
 */
export function buildServer(deps: ServerDeps) {
  const app = Fastify({ logger: false })

  // Capture raw body for HMAC verification while still parsing JSON for classify.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    ;(req as any).rawBody = body as string
    try {
      done(null, JSON.parse(body as string))
    } catch (err) {
      done(err as Error)
    }
  })

  if (deps.gitProvider === "github") {
    // ── GitHub branch ────────────────────────────────────────────────────────
    const { secret, classifyGithub, enqueuer } = deps
    app.post("/webhook", async (request, reply) => {
      const sig = (request.headers["x-hub-signature-256"] as string | undefined) ?? ""
      const rawBody = ((request as any).rawBody as string) ?? ""
      if (!verifyGithubSignature(rawBody, sig, secret)) {
        return reply.code(401).send({ error: "Unauthorized" })
      }

      const event = (request.headers["x-github-event"] as string | undefined) ?? ""
      const intent = classifyGithub(event, request.body)

      if (ACTIONABLE_TYPES.has(intent.type)) {
        await enqueuer.enqueue(intent as JobIntent)
      }

      return reply.code(200).send({ ok: true, type: intent.type })
    })
  } else {
    // ── GitLab branch (default) ──────────────────────────────────────────────
    const { secret, classify, enqueuer } = deps
    app.post("/webhook", async (request, reply) => {
      const headerToken = (request.headers["x-gitlab-token"] as string | undefined) ?? ""
      if (!verifyToken(headerToken, secret)) {
        return reply.code(401).send({ error: "Unauthorized" })
      }

      const intent = classify(request.body)

      if (ACTIONABLE_TYPES.has(intent.type)) {
        await enqueuer.enqueue(intent as JobIntent)
      }

      return reply.code(200).send({ ok: true, type: intent.type })
    })
  }

  return app
}

// ─── Production entry point ───────────────────────────────────────────────────

/**
 * Wires real Redis/BullMQ/classify and starts listening.
 * NOT exercised by unit tests (imports live deps inside this function).
 */
export async function main() {
  const { classify } = await import("./classifier.js")
  const { classifyGithub } = await import("./classifier-github.js")
  const { createQueue, bullmqEnqueuer } = await import("./queue.js")
  const { loadConfig } = await import("./config.js")

  const cfg = loadConfig(process.env as Record<string, string | undefined>)
  // Parse redisUrl into plain options so BullMQ uses its own bundled ioredis —
  // avoids the structural type mismatch between the top-level ioredis package
  // and the ioredis copy bundled inside bullmq.
  const redisUrl = new URL(cfg.redisUrl)
  const bullmqConnection = {
    host: redisUrl.hostname,
    port: Number(redisUrl.port) || 6379,
    ...(redisUrl.password ? { password: redisUrl.password } : {}),
    maxRetriesPerRequest: null,
  }
  const queue = await createQueue("zdc-jobs", bullmqConnection)
  const enqueuer = bullmqEnqueuer(queue)

  const port = Number(process.env["PORT"] ?? 3000)

  const app =
    cfg.gitProvider === "github"
      ? buildServer({ secret: cfg.webhookSecret, gitProvider: "github", classifyGithub, enqueuer })
      : buildServer({ secret: cfg.webhookSecret, classify, enqueuer })

  await app.listen({ port, host: "0.0.0.0" })
  console.log(`zdc-harness listening on :${port}`)
}
