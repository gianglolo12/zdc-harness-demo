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
