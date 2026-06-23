import { parse } from "yaml"

export interface RepoEntry {
  sourceRepo: string
  bundle: string
  controlPlaneRef: string
}

export interface Registry {
  repos: Record<string, RepoEntry>
}

export function loadRegistry(text: string): Registry {
  const raw = parse(text)
  const repos: Record<string, RepoEntry> = {}
  for (const [k, v] of Object.entries<any>(raw.repos ?? {}))
    repos[k] = { sourceRepo: v.source_repo, bundle: v.bundle, controlPlaneRef: v.control_plane_ref }
  return { repos }
}

export function resolve(reg: Registry, target: string): RepoEntry | null {
  return reg.repos[target] ?? null
}
