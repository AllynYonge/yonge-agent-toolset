import type { FsSearchMode, FsSearchScope } from '../cli/args.ts'

export type WorkspaceScopeConfig = {
  enabled: boolean
  include: string[]
  exclude: string[]
}

export type RagConfig = {
  enabled: boolean
  limit: number
  minSimilarity: number
}

export type KnowledgeSearchConfig = {
  vaultPath: string
  defaultMode: FsSearchMode
  defaultScope: FsSearchScope
  maxResults: number
  contentExtensions: string[]
  ignore: string[]
  followSymlinks: boolean
  maxFileBytes: number
  workspaceScope: WorkspaceScopeConfig
  rag: RagConfig
}
