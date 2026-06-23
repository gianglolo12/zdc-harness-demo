import Fastify from "fastify"
import { verifyToken } from "./verify-signature.js"
import type { Classified, JobIntent } from "./classifier.js"
import type { Enqueuer } from "./queue.js"

// ─── Injected dependencies interface ─────────────────────────────────────────

export interface ServerDeps {
  secret: string
  classify: (body: unknown) => Classified
  enqueuer: Enqueuer
}

// ─── Types that trigger an enqueue ───────────────────────────────────────────

const ACTIONABLE_TYPES = new Set(["impact", "approve", "revise", "reject", "abort"])

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Builds a Fastify instance with POST /webhook wired up.
 * All deps are injected so tests never need a live Redis/GitLab.
 */
export function buildServer(deps: ServerDeps) {
  const app = Fastify({ logger: false })

  app.post("/webhook", async (request, reply) => {
    // 1. Verify GitLab token
    const headerToken = (request.headers["x-gitlab-token"] as string | undefined) ?? ""
    if (!verifyToken(headerToken, deps.secret)) {
      return reply.code(401).send({ error: "Unauthorized" })
    }

    // 2. Classify payload
    const intent = deps.classify(request.body)

    // 3. Enqueue if actionable; otherwise 200 no-op
    if (ACTIONABLE_TYPES.has(intent.type)) {
      await deps.enqueuer.enqueue(intent as JobIntent)
    }

    return reply.code(200).send({ ok: true, type: intent.type })
  })

  return app
}

// ─── Production entry point ───────────────────────────────────────────────────

/**
 * Wires real Redis/BullMQ/classify and starts listening.
 * NOT exercised by unit tests (imports live deps inside this function).
 */
export async function main() {
  const { classify } = await import("./classifier.js")
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
  const app = buildServer({ secret: cfg.webhookSecret, classify, enqueuer })
  await app.listen({ port, host: "0.0.0.0" })
  console.log(`zdc-harness listening on :${port}`)
}
