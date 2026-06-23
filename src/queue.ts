import type { ConnectionOptions } from "bullmq"
import type { JobIntent } from "./classifier.js"

// ─── Injectable interface (keeps tests free of live Redis) ───────────────────

export interface Enqueuer {
  enqueue(job: JobIntent): Promise<void>
}

// ─── BullMQ queue factory ─────────────────────────────────────────────────────

/**
 * Creates a BullMQ Queue instance.
 * Import of bullmq is deferred inside main() so tests never touch it.
 */
export async function createQueue(name: string, connection: ConnectionOptions) {
  const { Queue } = await import("bullmq")
  return new Queue(name, { connection })
}

/**
 * Wraps a BullMQ Queue as an Enqueuer.
 * Only used in production (main()); tests inject a fake.
 */
export function bullmqEnqueuer(queue: { add(name: string, data: unknown): Promise<unknown> }): Enqueuer {
  return {
    async enqueue(job: JobIntent) {
      await queue.add(job.type, job)
    },
  }
}
