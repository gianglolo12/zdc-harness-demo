/**
 * Kill-switch: returns true when the harness should stop processing jobs.
 *
 * @param flagSource - Optional injectable function for testing.
 *   Defaults to reading `process.env.HARNESS_PAUSED === "1"`.
 */
export function isPaused(flagSource?: () => boolean): boolean {
  if (flagSource) return flagSource()
  return process.env.HARNESS_PAUSED === "1"
}
