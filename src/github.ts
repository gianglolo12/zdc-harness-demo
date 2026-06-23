import { Octokit } from "@octokit/rest"
import type { Config } from "./config.js"

export interface RepoRef {
  owner: string
  repo: string
}

export interface OctokitLike {
  pulls: {
    create(params: object): Promise<{ data: { number: number } }>
    get(params: object): Promise<unknown>
    update(params: object): Promise<unknown>
  }
  issues: {
    createComment(params: object): Promise<unknown>
    addLabels(params: object): Promise<unknown>
  }
}

export class GitHubClient {
  constructor(private readonly octokit: OctokitLike) {}

  async createDraftMR(
    repoRef: RepoRef,
    sourceBranch: string,
    title: string,
    body: string,
  ): Promise<{ iid: number }> {
    const { owner, repo } = repoRef
    const res = await this.octokit.pulls.create({
      owner,
      repo,
      head: sourceBranch,
      base: "main",
      title,
      body,
      draft: true,
    })
    return { iid: res.data.number }
  }

  async commentMR(repoRef: RepoRef, prNumber: number, body: string): Promise<unknown> {
    const { owner, repo } = repoRef
    return this.octokit.issues.createComment({ owner, repo, issue_number: prNumber, body })
  }

  async getMR(repoRef: RepoRef, prNumber: number): Promise<unknown> {
    const { owner, repo } = repoRef
    return this.octokit.pulls.get({ owner, repo, pull_number: prNumber })
  }

  async finalizeMR(repoRef: RepoRef, prNumber: number): Promise<unknown> {
    const { owner, repo } = repoRef
    return this.octokit.pulls.update({ owner, repo, pull_number: prNumber, draft: false })
  }

  async setLabel(repoRef: RepoRef, prNumber: number, label: string): Promise<unknown> {
    const { owner, repo } = repoRef
    return this.octokit.issues.addLabels({ owner, repo, issue_number: prNumber, labels: [label] })
  }
}

export function fromConfig(cfg: Config): GitHubClient {
  const octokit = new Octokit({ auth: cfg.github!.token }) as unknown as OctokitLike
  return new GitHubClient(octokit)
}
