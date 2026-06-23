import { describe, it, expect } from "vitest"
import { SqliteMemoryStore } from "./memory-store.js"

describe("memory", () => {
  it("write + search", () => {
    const m = new SqliteMemoryStore(":memory:")
    m.write({
      repo: "be",
      area: "payment",
      errorSignature: "ESP timeout",
      issue: "callback timeout",
      rootCause: "no retry",
      fix: "add retry",
      tags: ["esp"],
    })
    const r = m.search({ text: "callback timeout" })
    expect(r[0].fix).toBe("add retry")
  })

  it("search by area filter", () => {
    const m = new SqliteMemoryStore(":memory:")
    m.write({
      repo: "be",
      area: "auth",
      errorSignature: "jwt expired",
      issue: "token expiry problem",
      rootCause: "short ttl",
      fix: "increase ttl",
      tags: ["jwt"],
    })
    m.write({
      repo: "be",
      area: "payment",
      errorSignature: "timeout",
      issue: "token expiry problem",
      rootCause: "network issue",
      fix: "add timeout retry",
      tags: [],
    })
    const r = m.search({ text: "token expiry problem", area: "auth" })
    expect(r).toHaveLength(1)
    expect(r[0].area).toBe("auth")
  })

  it("supersede marks old inactive, search returns only new", () => {
    const m = new SqliteMemoryStore(":memory:")
    const oldId = m.write({
      repo: "be",
      area: "payment",
      errorSignature: "ESP timeout",
      issue: "callback timeout",
      rootCause: "no retry",
      fix: "add retry",
      tags: ["esp"],
    })
    const newId = m.supersede(oldId, {
      repo: "be",
      area: "payment",
      errorSignature: "ESP timeout",
      issue: "callback timeout",
      rootCause: "no retry",
      fix: "add retry with backoff",
      tags: ["esp", "backoff"],
    })
    expect(newId).not.toBe(oldId)
    const r = m.search({ text: "callback timeout" })
    expect(r).toHaveLength(1)
    expect(r[0].fix).toBe("add retry with backoff")
  })

  it("search respects limit", () => {
    const m = new SqliteMemoryStore(":memory:")
    for (let i = 0; i < 5; i++) {
      m.write({
        repo: "be",
        area: "payment",
        errorSignature: `sig-${i}`,
        issue: "shared keyword",
        rootCause: `root-${i}`,
        fix: `fix-${i}`,
        tags: [],
      })
    }
    const r = m.search({ text: "shared keyword", limit: 3 })
    expect(r.length).toBeLessThanOrEqual(3)
  })
})
