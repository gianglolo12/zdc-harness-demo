import { describe, it, expect, beforeEach } from "vitest"
import { InMemoryStateStore } from "./state-store.js"
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

  it("put then get returns the same job", () => {
    const job = makeJob()
    store.putJob("42", job)
    expect(store.getJob("42")).toEqual(job)
  })

  it("get on unknown mrIid returns undefined", () => {
    expect(store.getJob("999")).toBeUndefined()
  })

  it("incRevision starts at 1 on first call", () => {
    const rev = store.incRevision("10")
    expect(rev).toBe(1)
  })

  it("incRevision increments on subsequent calls", () => {
    store.incRevision("10")
    const rev2 = store.incRevision("10")
    expect(rev2).toBe(2)
    const rev3 = store.incRevision("10")
    expect(rev3).toBe(3)
  })

  it("different mrIids have independent revision counters", () => {
    store.incRevision("1")
    store.incRevision("1")
    store.incRevision("2")
    expect(store.incRevision("1")).toBe(3)
    expect(store.incRevision("2")).toBe(2)
  })
})
