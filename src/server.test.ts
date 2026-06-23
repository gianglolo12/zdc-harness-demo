import { createHmac } from "node:crypto"
import { describe, it, expect, vi } from "vitest"
import { buildServer } from "./server.js"
import type { Classified } from "./classifier.js"

// ─── Helpers ─────────────────────────────────────────────────────────────────

const VALID_PUSH_BODY = {
  object_kind: "push",
  ref: "refs/heads/feature-x",
  commits: [{ message: "[zdc:update-be my-prd]", added: ["po/spec.md"], modified: [], removed: [] }],
}

const IGNORE_BODY = {
  object_kind: "push",
  ref: "refs/heads/main", // protected → ignore
  commits: [{ message: "chore: bump", added: [], modified: [], removed: [] }],
}

// GitHub push body that matches zdc tag + po/ file
const GH_PUSH_BODY = {
  ref: "refs/heads/feature-x",
  commits: [{ message: "[zdc:update-be my-prd]", added: ["po/spec.md"], modified: [], removed: [] }],
}

const GH_IGNORE_BODY = {
  ref: "refs/heads/main",
  commits: [{ message: "chore: bump", added: [], modified: [], removed: [] }],
}

const GH_SECRET = "gh-test-secret"

function githubSig(body: string, secret = GH_SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex")
}

function makeServer(overrides?: { classifyFn?: (p: any) => Classified }) {
  const enqueued: any[] = []
  const enqueuer = {
    async enqueue(job: any) {
      enqueued.push(job)
    },
  }

  const server = buildServer({
    secret: "test-secret",
    classify: overrides?.classifyFn ?? ((p: any) => {
      // default: use real classifier behaviour via body inspection
      if (p.ref === "refs/heads/main") return { type: "ignore", reason: "protected branch" }
      return { type: "impact", target: "be", prd: "my-prd", ref: "feature-x" }
    }),
    enqueuer,
  })

  return { server, enqueued }
}

function makeGithubServer(overrides?: { classifyFn?: (event: string, p: any) => Classified }) {
  const enqueued: any[] = []
  const enqueuer = {
    async enqueue(job: any) {
      enqueued.push(job)
    },
  }

  const server = buildServer({
    secret: GH_SECRET,
    gitProvider: "github",
    classifyGithub: overrides?.classifyFn ?? ((event: string, p: any) => {
      if (event !== "push") return { type: "ignore", reason: `unhandled event: ${event}` }
      if (p.ref === "refs/heads/main") return { type: "ignore", reason: "protected branch" }
      return { type: "impact", target: "be", prd: "my-prd", ref: "feature-x" }
    }),
    enqueuer,
  })

  return { server, enqueued }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("POST /webhook", () => {
  it("valid token + impact payload → enqueue called once, returns 200", async () => {
    const { server, enqueued } = makeServer()

    const res = await server.inject({
      method: "POST",
      url: "/webhook",
      headers: { "x-gitlab-token": "test-secret", "content-type": "application/json" },
      payload: VALID_PUSH_BODY,
    })

    expect(res.statusCode).toBe(200)
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0].type).toBe("impact")
  })

  it("bad token → 401, enqueue NOT called", async () => {
    const { server, enqueued } = makeServer()

    const res = await server.inject({
      method: "POST",
      url: "/webhook",
      headers: { "x-gitlab-token": "wrong-secret-x", "content-type": "application/json" },
      payload: VALID_PUSH_BODY,
    })

    expect(res.statusCode).toBe(401)
    expect(enqueued).toHaveLength(0)
  })

  it("ignore payload → 200 no-op, enqueue NOT called", async () => {
    const { server, enqueued } = makeServer()

    const res = await server.inject({
      method: "POST",
      url: "/webhook",
      headers: { "x-gitlab-token": "test-secret", "content-type": "application/json" },
      payload: IGNORE_BODY,
    })

    expect(res.statusCode).toBe(200)
    expect(enqueued).toHaveLength(0)
  })

  it("approve intent → enqueue called once", async () => {
    const { server, enqueued } = makeServer({
      classifyFn: () => ({ type: "approve", mrIid: 42 }),
    })

    const res = await server.inject({
      method: "POST",
      url: "/webhook",
      headers: { "x-gitlab-token": "test-secret", "content-type": "application/json" },
      payload: { object_kind: "note" },
    })

    expect(res.statusCode).toBe(200)
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0].type).toBe("approve")
  })

  it("missing token header → 401", async () => {
    const { server, enqueued } = makeServer()

    const res = await server.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json" },
      payload: VALID_PUSH_BODY,
    })

    expect(res.statusCode).toBe(401)
    expect(enqueued).toHaveLength(0)
  })
})

// ─── GitHub provider tests ────────────────────────────────────────────────────

describe("POST /webhook (github provider)", () => {
  it("valid HMAC signature + push → enqueue called once, returns 200", async () => {
    const { server, enqueued } = makeGithubServer()
    const body = JSON.stringify(GH_PUSH_BODY)

    const res = await server.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-hub-signature-256": githubSig(body),
      },
      payload: body,
    })

    expect(res.statusCode).toBe(200)
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0].type).toBe("impact")
  })

  it("bad HMAC signature → 401, enqueue NOT called", async () => {
    const { server, enqueued } = makeGithubServer()
    const body = JSON.stringify(GH_PUSH_BODY)

    const res = await server.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-hub-signature-256": "sha256=deadbeef",
      },
      payload: body,
    })

    expect(res.statusCode).toBe(401)
    expect(enqueued).toHaveLength(0)
  })

  it("missing signature header → 401", async () => {
    const { server, enqueued } = makeGithubServer()
    const body = JSON.stringify(GH_PUSH_BODY)

    const res = await server.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json", "x-github-event": "push" },
      payload: body,
    })

    expect(res.statusCode).toBe(401)
    expect(enqueued).toHaveLength(0)
  })

  it("valid signature + ignore payload → 200 no-op, enqueue NOT called", async () => {
    const { server, enqueued } = makeGithubServer()
    const body = JSON.stringify(GH_IGNORE_BODY)

    const res = await server.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-hub-signature-256": githubSig(body),
      },
      payload: body,
    })

    expect(res.statusCode).toBe(200)
    expect(enqueued).toHaveLength(0)
  })
})
