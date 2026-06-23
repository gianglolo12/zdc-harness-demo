import { describe, it, expect } from "vitest"
import { isPaused } from "./kill-switch.js"

describe("isPaused", () => {
  it("returns false when env HARNESS_PAUSED is not set", () => {
    delete process.env.HARNESS_PAUSED
    expect(isPaused()).toBe(false)
  })

  it("returns false when HARNESS_PAUSED is '0'", () => {
    process.env.HARNESS_PAUSED = "0"
    expect(isPaused()).toBe(false)
    delete process.env.HARNESS_PAUSED
  })

  it("returns true when HARNESS_PAUSED is '1' (default env source)", () => {
    process.env.HARNESS_PAUSED = "1"
    expect(isPaused()).toBe(true)
    delete process.env.HARNESS_PAUSED
  })

  it("uses injected flagSource instead of env", () => {
    // env says not paused, but injected source says paused
    delete process.env.HARNESS_PAUSED
    expect(isPaused(() => true)).toBe(true)
  })

  it("injected flagSource returning false overrides env", () => {
    process.env.HARNESS_PAUSED = "1"
    expect(isPaused(() => false)).toBe(false)
    delete process.env.HARNESS_PAUSED
  })
})
