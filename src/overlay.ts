import { cp, appendFile, mkdir, access } from "node:fs/promises"
import { join } from "node:path"

export interface OverlayOpts {
  checkoutDir: string
  controlPlaneDir: string
  bundle: string
}

/**
 * Merge shared + bundle into checkout:
 * 1. Copy controlPlaneDir/.claude → checkoutDir/.claude (shared base)
 * 2. Copy controlPlaneDir/<bundle>/ → checkoutDir/.claude (bundle overrides shared on name clash)
 * 3. Copy <bundle>/CLAUDE.md → checkoutDir/CLAUDE.md if present
 * 4. Append .claude/ and CLAUDE.md to checkoutDir/.git/info/exclude (skip if .git absent)
 */
export async function overlay(opts: OverlayOpts): Promise<void> {
  const { checkoutDir, controlPlaneDir, bundle } = opts

  const sharedSrc = join(controlPlaneDir, ".claude")
  const bundleSrc = join(controlPlaneDir, bundle)
  const claudeDest = join(checkoutDir, ".claude")

  // Step 1: copy shared .claude → checkoutDir/.claude
  await cp(sharedSrc, claudeDest, { recursive: true, force: true })

  // Step 2: copy bundle dir contents → checkoutDir/.claude (overrides shared)
  await cp(bundleSrc, claudeDest, { recursive: true, force: true })

  // Step 3: copy bundle/CLAUDE.md → checkoutDir/CLAUDE.md if present
  const bundleClaudeMd = join(bundleSrc, "CLAUDE.md")
  const destClaudeMd = join(checkoutDir, "CLAUDE.md")
  try {
    await access(bundleClaudeMd)
    await cp(bundleClaudeMd, destClaudeMd, { force: true })
  } catch {
    // CLAUDE.md not present in bundle — skip
  }

  // Step 4: append to .git/info/exclude (create dirs if needed, skip if .git absent)
  const gitDir = join(checkoutDir, ".git")
  try {
    await access(gitDir)
    const excludeDir = join(gitDir, "info")
    await mkdir(excludeDir, { recursive: true })
    const excludeFile = join(excludeDir, "exclude")
    await appendFile(excludeFile, "\n.claude/\nCLAUDE.md\n")
  } catch {
    // No .git directory — skip gitignore step gracefully
  }
}

/**
 * Overlay the control-plane's `po/` PRD tree (ephemeral, not committed) into the
 * checkout so the agent can read the target PRD plus any cross-referenced PRDs.
 * Mirrors overlay()'s gitignore approach: copy recursively, then exclude `po/`.
 * Skips silently if `po/` (source) or `.git` (dest) is absent.
 */
export async function overlayPrdDocs(checkoutDir: string, controlPlaneDir: string): Promise<void> {
  const poSrc = join(controlPlaneDir, "po")
  try {
    await access(poSrc)
  } catch {
    // No po/ in control-plane — nothing to overlay.
    return
  }

  // Copy whole po/ tree into the checkout (force overwrite).
  await cp(poSrc, join(checkoutDir, "po"), { recursive: true, force: true })

  // Keep the source repo clean: exclude po/ so the agent never commits PRDs.
  try {
    const gitDir = join(checkoutDir, ".git")
    await access(gitDir)
    const excludeDir = join(gitDir, "info")
    await mkdir(excludeDir, { recursive: true })
    await appendFile(join(excludeDir, "exclude"), "\npo/\n")
  } catch {
    // No .git directory — skip gitignore step gracefully.
  }
}
