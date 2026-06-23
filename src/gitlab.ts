import { Gitlab } from "@gitbeaker/rest"
import type { Config } from "./config.js"

export interface GitLabApi {
  MergeRequests: {
    create(projectId: number, sourceBranch: string, targetBranch: string, title: string, opts?: object): Promise<unknown>
    show(projectId: number, mrIid: number): Promise<unknown>
  }
  MergeRequestNotes: {
    create(projectId: number, mrIid: number, body: string): Promise<unknown>
  }
}

export class GitLabClient {
  constructor(private readonly api: GitLabApi) {}

  async createDraftMR(
    projectId: number,
    sourceBranch: string,
    title: string,
    body: string,
    targetBranch = "main",
  ): Promise<unknown> {
    return this.api.MergeRequests.create(projectId, sourceBranch, targetBranch, `Draft: ${title}`, {
      description: body,
    })
  }

  async commentMR(projectId: number, mrIid: number, body: string): Promise<unknown> {
    return this.api.MergeRequestNotes.create(projectId, mrIid, body)
  }

  async getMR(projectId: number, mrIid: number): Promise<unknown> {
    return this.api.MergeRequests.show(projectId, mrIid)
  }
}

export function fromConfig(cfg: Config): GitLabClient {
  const api = new Gitlab({ host: cfg.gitlabUrl, token: cfg.gitlabToken }) as unknown as GitLabApi
  return new GitLabClient(api)
}
