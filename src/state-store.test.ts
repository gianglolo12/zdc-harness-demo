import { describe, it, expect, beforeEach } from "vitest"
import { InMemoryStateStore, RedisStateStore } from "./state-store.js"
import type { Job } from "./state-store.js"

const makeJob = (overrides?: Partial<Job>): Job => ({
  target: "backend",
  prd: "fix login bug",
  ref: "main",
  phase: "phase1",
  revisionCount: 0,
  ...overrides,
})

describe("InMemoryStateStore", () => {
  let store: InMemoryStateStore

  beforeEach(() => {
    store = new InMemoryStateStore()
  })

  it("put then get returns the same job", async () => {
    const job = makeJob()
    await store.putJob("42", job)
    expect(await store.getJob("42")).toEqual(job)
  })

  it("get on unknown mrIid returns undefined", async () => {
    expect(await store.getJob("999")).toBeUndefined()
  })

  it("incRevision starts at 1 on first call", async () => {
    const rev = await store.incRevision("10")
    expect(rev).toBe(1)
  })

  it("incRevision increments on subsequent calls", async () => {
    await store.incRevision("10")
    const rev2 = await store.incRevision("10")
    expect(rev2).toBe(2)
    const rev3 = await store.incRevision("10")
    expect(rev3).toBe(3)
  })

  it("different mrIids have independent revision counters", async () => {
    await store.incRevision("1")
    await store.incRevision("1")
    await store.incRevision("2")
    expect(await store.incRevision("1")).toBe(3)
    expect(await store.incRevision("2")).toBe(2)
  })
})

// ─── RedisStateStore unit tests (fake ioredis client) ─────────────────────────

function makeFakeRedis() {
  const data = new Map<string, string>()
  return {
    async set(key: string, value: string) {
      data.set(key, value)
    },
    async get(key: string) {
      return data.get(key) ?? null
    },
    async incr(key: string) {
      const current = Number(data.get(key) ?? "0")
      const next = current + 1
      data.set(key, String(next))
      return next
    },
    _data: data,
  }
}

describe("RedisStateStore", () => {
  it("putJob stores job as JSON; getJob retrieves and parses it", async () => {
    const redis = makeFakeRedis()
    const store = new RedisStateStore(redis)
    const job = makeJob({ prd: "PRD-99" })

    await store.putJob("5", job)

    expect(redis._data.get("job:5")).toBe(JSON.stringify(job))
    expect(await store.getJob("5")).toEqual(job)
  })

  it("getJob returns undefined for unknown key", async () => {
    const redis = makeFakeRedis()
    const store = new RedisStateStore(redis)
    expect(await store.getJob("missing")).toBeUndefined()
  })

  it("incRevision uses INCR — starts at 1 and increments", async () => {
    const redis = makeFakeRedis()
    const store = new RedisStateStore(redis)

    expect(await store.incRevision("7")).toBe(1)
    expect(await store.incRevision("7")).toBe(2)
    expect(await store.incRevision("7")).toBe(3)
  })

  it("incRevision uses key rev:<mrIid>", async () => {
    const redis = makeFakeRedis()
    const store = new RedisStateStore(redis)

    await store.incRevision("42")
    expect(redis._data.has("rev:42")).toBe(true)
  })

  it("different mrIids have independent revision counters", async () => {
    const redis = makeFakeRedis()
    const store = new RedisStateStore(redis)

    await store.incRevision("1")
    await store.incRevision("1")
    await store.incRevision("2")

    expect(await store.incRevision("1")).toBe(3)
    expect(await store.incRevision("2")).toBe(2)
  })
})
