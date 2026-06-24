import { describe, it, expect } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadManifest } from "./manifest.js"

function makeCp(): string {
  return mkdtempSync(join(tmpdir(), "manifest-"))
}

describe("loadManifest", () => {
  it("reads command names from manifest.json", () => {
    const cp = makeCp()
    mkdirSync(join(cp, "be"), { recursive: true })
    writeFileSync(
      join(cp, "be", "manifest.json"),
      JSON.stringify({ commands: { impact: "/x-impact", review: "/x-review", implement: "/x-impl" } }),
    )
    expect(loadManifest(cp, "be")).toEqual({ impact: "/x-impact", review: "/x-review", implement: "/x-impl" })
  })

  it("falls back to defaults when manifest absent", () => {
    const cp = makeCp()
    mkdirSync(join(cp, "be"), { recursive: true })
    expect(loadManifest(cp, "be")).toEqual({
      impact: "/auto-impact",
      review: "/auto-review-solution",
      implement: "/auto-implement",
    })
  })

  it("falls back per missing key", () => {
    const cp = makeCp()
    mkdirSync(join(cp, "be"), { recursive: true })
    writeFileSync(join(cp, "be", "manifest.json"), JSON.stringify({ commands: { impact: "/only-impact" } }))
    expect(loadManifest(cp, "be")).toEqual({
      impact: "/only-impact",
      review: "/auto-review-solution",
      implement: "/auto-implement",
    })
  })
})
