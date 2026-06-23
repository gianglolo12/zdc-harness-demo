/** Job represents a unit of work tracked per MR IID. */
export type Job = {
  target: string
  prd: string
  ref: string
  phase: string
  revisionCount: number
}

/** Interface that any state backend must satisfy. */
export interface StateStore {
  putJob(mrIid: string, job: Job): void
  getJob(mrIid: string): Job | undefined
  /** Increment revision counter for the given MR IID and return new value. */
  incRevision(mrIid: string): number
}

/** In-memory implementation — used in tests; no Redis required. */
export class InMemoryStateStore implements StateStore {
  private jobs = new Map<string, Job>()
  private revisions = new Map<string, number>()

  putJob(mrIid: string, job: Job): void {
    this.jobs.set(mrIid, job)
  }

  getJob(mrIid: string): Job | undefined {
    return this.jobs.get(mrIid)
  }

  incRevision(mrIid: string): number {
    const next = (this.revisions.get(mrIid) ?? 0) + 1
    this.revisions.set(mrIid, next)
    return next
  }
}

/**
 * Redis-backed implementation stub.
 * Requires a live Redis; not used in unit tests.
 */
export class RedisStateStore implements StateStore {
  // ioredis is imported dynamically to avoid requiring Redis at test time.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private redis: any

  constructor(redisClient: unknown) {
    this.redis = redisClient
  }

  async putJobAsync(mrIid: string, job: Job): Promise<void> {
    await this.redis.set(`job:${mrIid}`, JSON.stringify(job))
  }

  async getJobAsync(mrIid: string): Promise<Job | undefined> {
    const raw = await this.redis.get(`job:${mrIid}`)
    return raw ? (JSON.parse(raw) as Job) : undefined
  }

  async incRevisionAsync(mrIid: string): Promise<number> {
    return this.redis.incr(`rev:${mrIid}`)
  }

  // Sync interface stubs — throw to force async usage in production.
  putJob(_mrIid: string, _job: Job): void {
    throw new Error("Use putJobAsync for RedisStateStore")
  }

  getJob(_mrIid: string): Job | undefined {
    throw new Error("Use getJobAsync for RedisStateStore")
  }

  incRevision(_mrIid: string): number {
    throw new Error("Use incRevisionAsync for RedisStateStore")
  }
}
