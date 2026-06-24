// Progress store — tracks per-job pipeline status + live activity feed in Redis.
// Records are stored as JSON at `progress:<key>`, indexed in a zset `progress:index`
// scored by updatedAt, and published on the `progress` pub/sub channel so the
// server's SSE endpoint can stream updates to the dashboard.

const KEY_PREFIX = "progress:"
const INDEX_KEY = "progress:index"
const CHANNEL = "progress"
const ACTIVITY_CAP = 40
const LIST_CAP = 50

export interface ProgressStep {
  name: string
  status: "running" | "done" | "failed" | "pending"
}

export interface ProgressActivity {
  ts: number
  text: string
}

export interface ProgressRecord {
  key: string
  target?: string
  prd?: string
  phase?: string
  step?: string
  status?: string
  prUrl?: string
  mrIid?: number
  startedAt?: number
  updatedAt?: number
  steps: ProgressStep[]
  activity: ProgressActivity[]
}

/**
 * Patch accepted by report(). `activity` is a string (appended to the feed);
 * `step`+`status` upsert a step entry; `now` carries a runtime timestamp.
 * Any other ProgressRecord field is merged shallowly.
 */
export interface ProgressPatch {
  target?: string
  prd?: string
  phase?: string
  step?: string
  status?: ProgressStep["status"] | string
  prUrl?: string
  mrIid?: number
  activity?: string
  now?: number
}

// Minimal ioredis-shaped surface we depend on (real ioredis satisfies it; tests
// pass an in-memory fake). publish is best-effort.
export interface ProgressRedis {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<unknown>
  zadd(key: string, score: number, member: string): Promise<unknown>
  zrange(key: string, start: number, stop: number): Promise<string[]>
  mget(...keys: string[]): Promise<(string | null)[]>
  publish(channel: string, message: string): Promise<unknown>
}

export interface Progress {
  report(key: string, patch: ProgressPatch): Promise<void>
  list(): Promise<ProgressRecord[]>
  get(key: string): Promise<ProgressRecord | undefined>
}

function emptyRecord(key: string): ProgressRecord {
  return { key, steps: [], activity: [] }
}

export function createProgress(redis: ProgressRedis): Progress {
  async function get(key: string): Promise<ProgressRecord | undefined> {
    const raw = await redis.get(KEY_PREFIX + key)
    if (!raw) return undefined
    try {
      return JSON.parse(raw) as ProgressRecord
    } catch {
      return undefined
    }
  }

  // Serialize all report() calls: each does a read-modify-write of the JSON
  // record, and the worker fires many concurrent (un-awaited) reports per job
  // (step transitions + every tool_use activity). Without serialization those
  // races clobber each other (lost updates → empty activity feed, stuck steps).
  // One in-process chain keeps them sequential (single worker, low volume).
  let chain: Promise<void> = Promise.resolve()
  function report(key: string, patch: ProgressPatch): Promise<void> {
    const run = chain.then(() => doReport(key, patch))
    chain = run.catch(() => {})
    return run
  }

  async function doReport(key: string, patch: ProgressPatch): Promise<void> {
    const existing = (await get(key)) ?? emptyRecord(key)
    const now = typeof patch.now === "number" ? patch.now : Date.now()

    const record: ProgressRecord = { ...existing, key }

    // Merge scalar fields (skip the special handling fields).
    if (patch.target !== undefined) record.target = patch.target
    if (patch.prd !== undefined) record.prd = patch.prd
    if (patch.phase !== undefined) record.phase = patch.phase
    if (patch.prUrl !== undefined) record.prUrl = patch.prUrl
    if (patch.mrIid !== undefined) record.mrIid = patch.mrIid

    // Activity: append capped feed entry.
    if (typeof patch.activity === "string") {
      record.activity = [...record.activity, { ts: now, text: patch.activity }]
      if (record.activity.length > ACTIVITY_CAP) {
        record.activity = record.activity.slice(record.activity.length - ACTIVITY_CAP)
      }
    }

    // Step upsert (by name) when both step + status present.
    if (patch.step && patch.status) {
      const status = patch.status as ProgressStep["status"]
      const idx = record.steps.findIndex((s) => s.name === patch.step)
      if (idx >= 0) {
        record.steps[idx] = { name: patch.step, status }
      } else {
        record.steps = [...record.steps, { name: patch.step, status }]
      }
      record.step = patch.step
      record.status = patch.status
    } else if (patch.status !== undefined) {
      // Job-level status (running/done/failed) without a specific step.
      record.status = patch.status
    } else if (patch.step !== undefined) {
      record.step = patch.step
    }

    if (record.startedAt === undefined) record.startedAt = now
    record.updatedAt = now

    const serialized = JSON.stringify(record)
    await redis.set(KEY_PREFIX + key, serialized)
    await redis.zadd(INDEX_KEY, now, key)
    await redis.publish(CHANNEL, serialized)
  }

  async function list(): Promise<ProgressRecord[]> {
    // Newest first: zrange returns ascending by score, so read the tail.
    const keys = await redis.zrange(INDEX_KEY, 0, -1)
    if (keys.length === 0) return []
    const ordered = keys.slice().reverse().slice(0, LIST_CAP)
    const raws = await redis.mget(...ordered.map((k) => KEY_PREFIX + k))
    const records: ProgressRecord[] = []
    for (const raw of raws) {
      if (!raw) continue
      try {
        records.push(JSON.parse(raw) as ProgressRecord)
      } catch {
        // skip corrupt entries
      }
    }
    return records
  }

  return { report, list, get }
}
