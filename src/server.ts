import Fastify, { type FastifyInstance } from "fastify"
import { verifyToken, verifyGithubSignature } from "./verify-signature.js"
import type { Classified, JobIntent } from "./classifier.js"
import type { Enqueuer } from "./queue.js"
import type { Progress, ProgressRecord } from "./progress.js"
import { dashboardHtml } from "./dashboard-html.js"

// ─── Injected dependencies interface ─────────────────────────────────────────

/**
 * Optional dashboard wiring. When present, the server exposes:
 *   GET /api/jobs   — snapshot via progress.list()
 *   GET /api/stream — SSE; `subscribe` registers an onMessage handler and
 *                     returns an unsubscribe fn (backed by a Redis SUBSCRIBE
 *                     in main(); a no-op/EventEmitter in tests).
 *   GET /ui         — self-contained dashboard HTML.
 * All three are guarded — absent deps → those routes are simply not registered.
 */
export interface DashboardDeps {
  progress?: Pick<Progress, "list">
  subscribe?: (onMessage: (record: ProgressRecord) => void) => () => void
}

export type ServerDeps = (
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
) &
  DashboardDeps

// ─── Types that trigger an enqueue ───────────────────────────────────────────

const ACTIONABLE_TYPES = new Set(["impact", "approve", "revise", "reject", "abort", "merged"])

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

  // ── Dashboard routes (guarded — only when deps supplied) ────────────────────
  registerDashboardRoutes(app, deps)

  return app
}

// ─── Dashboard routes ──────────────────────────────────────────────────────────

const HEARTBEAT_MS = 15_000

function registerDashboardRoutes(app: FastifyInstance, deps: DashboardDeps): void {
  const { progress, subscribe } = deps

  // GET /ui — always available (the page degrades gracefully if APIs are absent).
  app.get("/ui", async (_request, reply) => {
    reply.header("Content-Type", "text/html; charset=utf-8")
    return reply.send(dashboardHtml)
  })

  if (progress) {
    app.get("/api/jobs", async (_request, reply) => {
      const list = await progress.list()
      return reply.send(list)
    })
  }

  if (subscribe) {
    app.get("/api/stream", (request, reply) => {
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      })
      // Initial comment so proxies flush headers immediately.
      reply.raw.write(": connected\n\n")

      const send = (record: ProgressRecord) => {
        reply.raw.write(`data: ${JSON.stringify(record)}\n\n`)
      }
      const unsubscribe = subscribe(send)

      const heartbeat = setInterval(() => {
        reply.raw.write(": heartbeat\n\n")
      }, HEARTBEAT_MS)

      const cleanup = () => {
        clearInterval(heartbeat)
        unsubscribe()
      }
      request.raw.on("close", cleanup)
      reply.raw.on("error", cleanup)

      // Take over the socket so Fastify doesn't try to send its own response.
      reply.hijack()
    })
  }
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
  const { default: IORedis } = await import("ioredis")
  const { createProgress } = await import("./progress.js")

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

  // ── Dashboard wiring ─────────────────────────────────────────────────────────
  // One ioredis client for progress.list() snapshots, plus a dedicated subscriber
  // connection (a connection in subscribe mode can't run normal commands). Each
  // SSE client registers a listener; the single subscriber fans out to all of them.
  const progressRedis = new IORedis(cfg.redisUrl, { maxRetriesPerRequest: null })
  const subRedis = new IORedis(cfg.redisUrl, { maxRetriesPerRequest: null })
  const progress = createProgress(progressRedis as unknown as Parameters<typeof createProgress>[0])

  type RecordListener = (record: import("./progress.js").ProgressRecord) => void
  const listeners = new Set<RecordListener>()
  await subRedis.subscribe("progress")
  subRedis.on("message", (_channel: string, message: string) => {
    let record: import("./progress.js").ProgressRecord
    try {
      record = JSON.parse(message)
    } catch {
      return
    }
    for (const l of listeners) {
      try {
        l(record)
      } catch {
        // best-effort fan-out
      }
    }
  })
  const subscribe = (onMessage: RecordListener) => {
    listeners.add(onMessage)
    return () => listeners.delete(onMessage)
  }

  const port = Number(process.env["PORT"] ?? 3000)

  const app =
    cfg.gitProvider === "github"
      ? buildServer({ secret: cfg.webhookSecret, gitProvider: "github", classifyGithub, enqueuer, progress, subscribe })
      : buildServer({ secret: cfg.webhookSecret, classify, enqueuer, progress, subscribe })

  await app.listen({ port, host: "0.0.0.0" })
  console.log(`zdc-harness listening on :${port}`)
}
