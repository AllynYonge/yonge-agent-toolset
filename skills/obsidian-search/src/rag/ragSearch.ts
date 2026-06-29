import type { KnowledgeSearchConfig } from '../config/schema.ts'
import type { SearchScopeTarget } from '../fs/nodeFsAdapter.ts'
import { isPathAllowedByScope } from '../scope/workspaceScope.ts'
import type { SuperSearchResult } from '../search/types.ts'
import { embedText } from './embeddings.ts'
import type { RagEmbeddingRow } from './types.ts'
import { YoloVectorDbReader } from './yoloVectorDb.ts'
import {
  type YoloEmbeddingModelSettings,
  type YoloProviderSettings,
  type YoloResolvedSettings,
  loadYoloResolvedSettings,
  resolveEmbeddingModel,
  resolveProvider,
} from './yoloPluginSettings.ts'

const MAX_RAG_SNIPPET_CHARS = 500

const truncateRagSnippet = (text: string): string => {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= MAX_RAG_SNIPPET_CHARS) return normalized
  return `${normalized.slice(0, MAX_RAG_SNIPPET_CHARS)}...`
}

const dedupeRagRows = (rows: RagEmbeddingRow[]): RagEmbeddingRow[] => {
  const seen = new Set<string>()
  const deduped: RagEmbeddingRow[] = []
  for (const row of rows) {
    const key = `${row.path}:${row.metadata.page ?? ''}:${row.metadata.startLine}:${row.metadata.endLine}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(row)
  }
  return deduped
}

const mapRagRowsToSuper = (rows: RagEmbeddingRow[]): SuperSearchResult[] => {
  return rows.map((row) => {
    const page = row.metadata.page
    const locLine = page ?? row.metadata.startLine
    const locEnd = page ?? row.metadata.endLine
    return {
      kind: 'content' as const,
      path: row.path,
      line: locLine,
      startLine: locLine,
      endLine: locEnd,
      page,
      snippet: truncateRagSnippet(row.content),
      similarity: row.similarity,
      source: 'rag' as const,
    }
  })
}

export type RagSearchRequest = {
  config: KnowledgeSearchConfig
  query: string
  scope: SearchScopeTarget
  minSimilarity: number
  limit: number
}

export class YoloRagSession {
  private readonly reader: YoloVectorDbReader
  private readonly model: YoloEmbeddingModelSettings
  private readonly provider: YoloProviderSettings

  private constructor(
    private readonly config: KnowledgeSearchConfig,
    resolved: YoloResolvedSettings,
  ) {
    if (resolved.settings.ragOptions?.enabled === false) {
      throw new Error('YOLO RAG is disabled in plugin settings.')
    }
    this.model = resolveEmbeddingModel(resolved.settings)
    this.provider = resolveProvider(resolved.settings, this.model.providerId)
    this.reader = new YoloVectorDbReader(resolved)
  }

  static async create(config: KnowledgeSearchConfig): Promise<YoloRagSession> {
    const resolved = await loadYoloResolvedSettings(config)
    const session = new YoloRagSession(config, resolved)
    if (!(await session.reader.hasModel(session.model))) {
      const stats = await session.reader.getModelStats()
      const available = stats.map((row) => `${row.model}/${row.dimension}:${row.chunks}`).join(', ')
      await session.close()
      throw new Error(
        `No vector rows found for ${session.model.id}/${session.model.dimension}. Available: ${available || 'none'}`,
      )
    }
    return session
  }

  async search({
    query,
    scope,
    minSimilarity,
    limit,
  }: Omit<RagSearchRequest, 'config'>): Promise<SuperSearchResult[]> {
    const queryVector = await embedText({ provider: this.provider, model: this.model, text: query })
    const rows = await this.reader.similaritySearch({
      queryVector,
      model: this.model,
      minSimilarity,
      limit,
      scope,
    })
    return mapRagRowsToSuper(dedupeRagRows(rows)).filter((result) =>
      isPathAllowedByScope(result.path, this.config.workspaceScope),
    )
  }

  async close(): Promise<void> {
    await this.reader.close()
  }
}

export async function searchRag(request: RagSearchRequest): Promise<SuperSearchResult[]> {
  const session = await YoloRagSession.create(request.config)
  try {
    return await session.search(request)
  } finally {
    await session.close()
  }
}
