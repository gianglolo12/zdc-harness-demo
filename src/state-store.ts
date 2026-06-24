/** Job represents a unit of work tracked per MR IID. */
export type Job = {
  target: string
  prd: string
  ref: string
  phase: string
  revisionCount: number
  /** Control-plane Issue number that dispatched this job (closed on merge). */
  dispatchIssue?: number
}

/** Interface that any state backend must satisfy. All methods are async. */
export interface StateStore {
  putJob(mrIid: string, job: Job): Promise<void>
  getJob(mrIid: string): Promise<Job | undefined>
  /** Increment revision counter for the given MR IID and return new value. */
  incRevision(mrIid: string): Promise<number>
}

/** In-memory implementation — used in tests; no Redis required. */
export class InMemoryStateStore implements StateStore {
  private jobs = new Map<string, Job>()
  private revisions = new Map<string, number>()

  async putJob(mrIid: string, job: Job): Promise<void> {
    this.jobs.set(mrIid, job)
  }

  async getJob(mrIid: string): Promise<Job | undefined> {
    return this.jobs.get(mrIid)
  }

  async incRevision(mrIid: string): Promise<number> {
    const next = (this.revisions.get(mrIid) ?? 0) + 1
    this.revisions.set(mrIid, next)
    return next
  }
}

/**
 * Redis-backed implementation.
 * Stores jobs as JSON under key `job:<mrIid>`.
 * Tracks revision counters under key `rev:<mrIid>` via INCR.
 * Requires a live Redis; not used in unit tests.
 */
export class RedisStateStore implements StateStore {
  // ioredis is imported dynamically to avoid requiring Redis at test time.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private redis: any

  constructor(redisClient: unknown) {
    this.redis = redisClient
  }

  async putJob(mrIid: string, job: Job): Promise<void> {
    await this.redis.set(`job:${mrIid}`, JSON.stringify(job))
  }

  async getJob(mrIid: string): Promise<Job | undefined> {
    const raw = await this.redis.get(`job:${mrIid}`)
    return raw ? (JSON.parse(raw) as Job) : undefined
  }

  async incRevision(mrIid: string): Promise<number> {
    return this.redis.incr(`rev:${mrIid}`)
  }
}
