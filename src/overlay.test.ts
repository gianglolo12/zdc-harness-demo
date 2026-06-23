import { describe, it, expect } from "vitest"
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { overlay } from "./overlay.js"

describe("overlay", () => {
  it("bundle đè shared", async () => {
    const root = await mkdtemp(join(tmpdir(), "ov-"))
    const cp = join(root, "cp"), co = join(root, "co")
    await mkdir(join(cp, ".claude"), { recursive: true })
    await mkdir(join(cp, "be"), { recursive: true })
    await mkdir(co, { recursive: true })
    await writeFile(join(cp, ".claude", "shared.md"), "SHARED")
    await writeFile(join(cp, ".claude", "dup.md"), "FROM-SHARED")
    await writeFile(join(cp, "be", "dup.md"), "FROM-BUNDLE")
    await writeFile(join(cp, "be", "CLAUDE.md"), "BE-CLAUDE")
    await overlay({ checkoutDir: co, controlPlaneDir: cp, bundle: "be" })
    expect(await readFile(join(co, ".claude", "shared.md"), "utf8")).toBe("SHARED")
    expect(await readFile(join(co, ".claude", "dup.md"), "utf8")).toBe("FROM-BUNDLE")
    expect(await readFile(join(co, "CLAUDE.md"), "utf8")).toBe("BE-CLAUDE")
  })

  it("exclude entries appended (no .git dir → skip gracefully)", async () => {
    const root = await mkdtemp(join(tmpdir(), "ov-"))
    const cp = join(root, "cp"), co = join(root, "co")
    await mkdir(join(cp, ".claude"), { recursive: true })
    await mkdir(join(cp, "be"), { recursive: true })
    await mkdir(co, { recursive: true })
    await writeFile(join(cp, ".claude", "shared.md"), "S")
    await writeFile(join(cp, "be", "extra.md"), "E")
    // No .git dir in co — overlay should not throw
    await expect(overlay({ checkoutDir: co, controlPlaneDir: cp, bundle: "be" })).resolves.toBeUndefined()
  })

  it("exclude entries appended when .git/info exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "ov-"))
    const cp = join(root, "cp"), co = join(root, "co")
    await mkdir(join(cp, ".claude"), { recursive: true })
    await mkdir(join(cp, "be"), { recursive: true })
    await mkdir(join(co, ".git", "info"), { recursive: true })
    await writeFile(join(cp, ".claude", "shared.md"), "S")
    await writeFile(join(cp, "be", "extra.md"), "E")
    await overlay({ checkoutDir: co, controlPlaneDir: cp, bundle: "be" })
    const exclude = await readFile(join(co, ".git", "info", "exclude"), "utf8")
    expect(exclude).toContain(".claude/")
    expect(exclude).toContain("CLAUDE.md")
  })
})
