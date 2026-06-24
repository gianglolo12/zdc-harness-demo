import { readFileSync } from "node:fs"
import { join } from "node:path"

/** Command names a role bundle declares for each pipeline stage. */
export interface ManifestCommands {
  impact: string
  review: string
  implement: string
}

// Defaults used when manifest.json is missing, unreadable, or a key is absent.
const DEFAULTS: ManifestCommands = {
  impact: "/auto-impact",
  review: "/auto-review-solution",
  implement: "/auto-implement",
}

/**
 * Load the command names a bundle declares in <controlPlaneDir>/<bundle>/manifest.json.
 * Expected shape: { "commands": { "impact": "...", "review": "...", "implement": "..." } }.
 * Falls back per-missing-key (and on any read/parse error) to the defaults so the
 * pipeline keeps working even before a bundle ships a manifest.
 */
export function loadManifest(controlPlaneDir: string, bundle: string): ManifestCommands {
  try {
    const raw = readFileSync(join(controlPlaneDir, bundle, "manifest.json"), "utf8")
    const parsed = JSON.parse(raw) as { commands?: Partial<ManifestCommands> }
    const cmds = parsed.commands ?? {}
    return {
      impact: typeof cmds.impact === "string" ? cmds.impact : DEFAULTS.impact,
      review: typeof cmds.review === "string" ? cmds.review : DEFAULTS.review,
      implement: typeof cmds.implement === "string" ? cmds.implement : DEFAULTS.implement,
    }
  } catch {
    // File absent / unreadable / invalid JSON — use all defaults.
    return { ...DEFAULTS }
  }
}
