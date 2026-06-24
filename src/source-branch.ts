/**
 * Derive the source-repo branch name for a job: `zdc-<role>-<prd>`, lowercased,
 * with any character outside [a-z0-9._/-] replaced by `-`. This keeps the branch
 * git-ref-safe regardless of how PRD/feature ids are formatted (e.g. "G3-FB08").
 * Example: sourceBranch("be", "G3-FB08") => "zdc-be-g3-fb08".
 */
export function sourceBranch(role: string, prd: string): string {
  return `zdc-${role}-${prd}`.toLowerCase().replace(/[^a-z0-9._/-]/g, "-")
}
