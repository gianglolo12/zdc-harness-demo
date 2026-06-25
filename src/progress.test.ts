import { describe, it, expect, beforeEach } from "vitest"
import { createProgress, type ProgressRedis } from "./progress.js"

// In-memory fake of the minimal ioredis surface progress.ts depends on.
class FakeRedis implements ProgressRedis {
  store = new Map<string, string>()
  zset = new Map<string, number>() // member -> score
  published: { channel: string; message: string }[] = []

  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? this.store.get(key)! : null
  }
  async set(key: string, value: string): Promise<unknown> {
    this.store.set(key, value)
    return "OK"
  }
  async zadd(key: string, score: number, member: string): Promise<unknown> {
    this.zset.set(member, score)
    return 1
  }
  async zrange(_key: string, start: number, stop: number): Promise<string[]> {
    // Ascending by score (ties: insertion order via Map iteration).
    const sorted = [...this.zset.entries()].sort((a, b) => a[1] - b[1]).map(([m]) => m)
    const end = stop === -1 ? sorted.length : stop + 1
    return sorted.slice(start, end)
  }
  async mget(...keys: string[]): Promise<(string | null)[]> {
    return keys.map((k) => (this.store.has(k) ? this.store.get(k)! : null))
  }
  async publish(channel: string, message: string): Promise<unknown> {
    this.published.push({ channel, message })
    return 1
  }
}

describe("createProgress", () => {
  let redis: FakeRedis

  beforeEach(() => {
    redis = new FakeRedis()
  })

  it("report() creates a record, persists, indexes, and publishes", async () => {
    const p = createProgress(redis)
    await p.report("be-F07", { target: "be", prd: "F07", phase: "phase1", now: 1000 })

    const rec = await p.get("be-F07")
    expect(rec).toBeDefined()
    expect(rec!.target).toBe("be")
    expect(rec!.prd).toBe("F07")
    expect(rec!.phase).toBe("phase1")
    expect(rec!.startedAt).toBe(1000)
    expect(rec!.updatedAt).toBe(1000)
    // indexed
    expect(redis.zset.get("be-F07")).toBe(1000)
    // published serialized record on the progress channel
    expect(redis.published).toHaveLength(1)
    expect(redis.published[0]!.channel).toBe("progress")
    expect(JSON.parse(redis.published[0]!.message).key).toBe("be-F07")
  })

  it("upserts steps by name (running → done) and tracks current step/status", async () => {
    const p = createProgress(redis)
    await p.report("be-F07", { step: "checkout", status: "running", now: 1 })
    await p.report("be-F07", { step: "overlay", status: "running", now: 2 })
    await p.report("be-F07", { step: "checkout", status: "done", now: 3 })

    const rec = (await p.get("be-F07"))!
    expect(rec.steps).toEqual([
      { name: "checkout", status: "done" },
      { name: "overlay", status: "running" },
    ])
    // current step/status reflects the most recent step report
    expect(rec.step).toBe("checkout")
    expect(rec.status).toBe("done")
  })

  it("appends activity and caps the feed at 200 entries", async () => {
    const p = createProgress(redis)
    for (let i = 0; i < 210; i++) {
      await p.report("be-F07", { activity: `act-${i}`, now: i })
    }
    const rec = (await p.get("be-F07"))!
    expect(rec.activity).toHaveLength(200)
    // oldest dropped, newest kept
    expect(rec.activity[0]!.text).toBe("act-10")
    expect(rec.activity.at(-1)!.text).toBe("act-209")
  })

  it("job-level status without a step does not create a step entry", async () => {
    const p = createProgress(redis)
    await p.report("be-F07", { status: "done", now: 5 })
    const rec = (await p.get("be-F07"))!
    expect(rec.steps).toEqual([])
    expect(rec.status).toBe("done")
  })

  it("list() returns records newest-first by updatedAt", async () => {
    const p = createProgress(redis)
    await p.report("a", { now: 100 })
    await p.report("b", { now: 300 })
    await p.report("c", { now: 200 })

    const list = await p.list()
    expect(list.map((r) => r.key)).toEqual(["b", "c", "a"])
  })

  it("list() returns empty array when nothing indexed", async () => {
    const p = createProgress(redis)
    expect(await p.list()).toEqual([])
  })

  it("get() returns undefined for an unknown key", async () => {
    const p = createProgress(redis)
    expect(await p.get("missing")).toBeUndefined()
  })

  it("preserves prUrl and mrIid across reports", async () => {
    const p = createProgress(redis)
    await p.report("be-F07", { mrIid: 42, now: 1 })
    await p.report("be-F07", { prUrl: "https://github.com/x/y/pull/42", now: 2 })
    const rec = (await p.get("be-F07"))!
    expect(rec.mrIid).toBe(42)
    expect(rec.prUrl).toBe("https://github.com/x/y/pull/42")
  })

  it("reset clears stale steps/activity/timing for a fresh run", async () => {
    const p = createProgress(redis)
    await p.report("be-F07", { step: "checkout", status: "done", now: 100 })
    await p.report("be-F07", { activity: "old action", now: 110 })
    await p.report("be-F07", { reset: true, phase: "phase1", status: "running", now: 500 })
    const rec = (await p.get("be-F07"))!
    expect(rec.steps).toEqual([])
    expect(rec.activity).toEqual([])
    expect(rec.startedAt).toBe(500)
    expect(rec.phase).toBe("phase1")
  })

  it("tags each activity with the currently-active step", async () => {
    const p = createProgress(redis)
    await p.report("be-F07", { step: "auto-impact", status: "running", now: 1 })
    await p.report("be-F07", { activity: "Read FRS", now: 2 })
    await p.report("be-F07", { step: "auto-implement", status: "running", now: 3 })
    await p.report("be-F07", { activity: "Bash mvn test", now: 4 })
    const rec = (await p.get("be-F07"))!
    expect(rec.activity.map((a) => [a.step, a.text])).toEqual([
      ["auto-impact", "Read FRS"],
      ["auto-implement", "Bash mvn test"],
    ])
  })
})
