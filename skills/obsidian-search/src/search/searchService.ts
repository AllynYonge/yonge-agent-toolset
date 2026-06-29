import type { CliArgs, FsSearchMode, FsSearchScope } from '../cli/args.ts'
import type { KnowledgeSearchConfig } from '../config/schema.ts'
import { NodeFsAdapter, resolveSearchScopeByPath } from '../fs/nodeFsAdapter.ts'
import { annotateResultsWithCitations } from '../citations/annotateResults.ts'
import { aggregateSearchResults } from './resultAggregation.ts'
import { collectKeywordSearchResults } from './keywordSearch.ts'
import { fuseRrfHybrid } from './hybridSearch.ts'
import { searchRag, type RagSearchRequest } from '../rag/ragSearch.ts'
import type { SearchStats, SuperSearchResult } from './types.ts'

type RagSearchFn = (request: RagSearchRequest) => Promise<SuperSearchResult[]>

const RAG_FETCH_LIMIT_MAX = 300

export type KnowledgeSearchResponse = {
  tool: 'knowledge_search'
  requestedMode: FsSearchMode
  effectiveMode: FsSearchMode
  fallbackReason?: string
  scope: FsSearchScope
  query: string
  path: string
  results: ReturnType<typeof annotateResultsWithCitations>['results']
  citations: ReturnType<typeof annotateResultsWithCitations>['citations']
  stats: SearchStats
}

const clampInteger = (value: number, min: number, max: number): number => {
  return Math.min(Math.max(Math.trunc(value), min), max)
}

const getSemanticSearchUnavailableReason = (config: KnowledgeSearchConfig): string | null => {
  if (!config.rag.enabled) return 'RAG is not enabled. Fell back to keyword search.'
  return null
}

const emptyStats = (): SearchStats => ({
  scannedFiles: 0,
  scannedContentFiles: 0,
  skippedFiles: [],
  durationMs: 0,
})

export async function runKnowledgeSearch(
  config: KnowledgeSearchConfig,
  args: CliArgs,
  options: { ragSearch?: RagSearchFn } = {},
): Promise<KnowledgeSearchResponse> {
  const ragSearch = options.ragSearch ?? searchRag
  const startedAt = performance.now()
  const requestedMode = args.mode ?? config.defaultMode
  const query = (args.query ?? '').trim()
  const maxResults = clampInteger(args.maxResults ?? config.maxResults, 1, 300)
  const caseSensitive = args.caseSensitive ?? false
  const scopeTarget = await resolveSearchScopeByPath(config, args.path)
  const adapter = new NodeFsAdapter(config)
  const stats = emptyStats()

  if (args.workspaceInclude.length > 0 || args.workspaceExclude.length > 0) {
    config.workspaceScope = {
      enabled: true,
      include: args.workspaceInclude.length > 0 ? args.workspaceInclude : config.workspaceScope.include,
      exclude: args.workspaceExclude.length > 0 ? args.workspaceExclude : config.workspaceScope.exclude,
    }
  }

  const semanticUnavailableReason = requestedMode === 'keyword' ? null : getSemanticSearchUnavailableReason(config)
  const effectiveMode: FsSearchMode = requestedMode === 'hybrid' && semanticUnavailableReason ? 'keyword' : requestedMode

  if (effectiveMode === 'keyword') {
    const scope = args.scope ?? config.defaultScope
    const keywordResults = await collectKeywordSearchResults({
      adapter,
      config,
      scopeTarget,
      scope,
      query,
      maxResults,
      caseSensitive,
      stats,
    })
    const annotated = annotateResultsWithCitations(aggregateSearchResults({ results: keywordResults, maxResults }))
    stats.durationMs = Math.round(performance.now() - startedAt)
    return {
      tool: 'knowledge_search',
      requestedMode,
      effectiveMode,
      fallbackReason: requestedMode !== effectiveMode ? semanticUnavailableReason ?? undefined : undefined,
      scope,
      query,
      path: scopeTarget.normalizedPath,
      results: annotated.results,
      citations: annotated.citations,
      stats,
    }
  }

  if (semanticUnavailableReason) {
    throw new Error(semanticUnavailableReason.replace(' Fell back to keyword search.', ''))
  }
  if (!query) throw new Error('query is required for rag/hybrid mode.')
  const rawScope = args.scope
  if (rawScope === 'files' || rawScope === 'dirs') {
    throw new Error('rag mode only supports content search. Use keyword or hybrid for file/dir search.')
  }

  const ragLimit = clampInteger(args.ragLimit ?? config.rag.limit, 1, RAG_FETCH_LIMIT_MAX)
  const ragMinSimilarity = args.ragMinSimilarity ?? config.rag.minSimilarity

  if (effectiveMode === 'rag') {
    const ragResults = await ragSearch({
      config,
      query,
      scope: scopeTarget,
      minSimilarity: ragMinSimilarity,
      limit: ragLimit,
    })
    const effectiveScope: FsSearchScope = rawScope === undefined ? 'content' : rawScope
    const annotated = annotateResultsWithCitations(
      aggregateSearchResults({ results: ragResults.slice(0, maxResults), maxResults }),
    )
    stats.durationMs = Math.round(performance.now() - startedAt)
    return {
      tool: 'knowledge_search',
      requestedMode,
      effectiveMode: 'rag',
      scope: effectiveScope,
      query,
      path: scopeTarget.normalizedPath,
      results: annotated.results,
      citations: annotated.citations,
      stats,
    }
  }

  let ragResults: SuperSearchResult[]
  let hybridFallbackReason: string | undefined
  try {
    ragResults = await searchRag({
      config,
      query,
      scope: scopeTarget,
      minSimilarity: ragMinSimilarity,
      limit: ragLimit,
    })
  } catch (error) {
    hybridFallbackReason = `${error instanceof Error ? error.message : String(error)} Fell back to keyword search.`
    const keywordResults = await collectKeywordSearchResults({
      adapter,
      config,
      scopeTarget,
      scope: 'content',
      query,
      maxResults,
      caseSensitive,
      stats,
    })
    const annotated = annotateResultsWithCitations(
      aggregateSearchResults({ results: keywordResults, maxResults }),
    )
    stats.durationMs = Math.round(performance.now() - startedAt)
    return {
      tool: 'knowledge_search',
      requestedMode,
      effectiveMode: 'keyword',
      fallbackReason: hybridFallbackReason,
      scope: 'content',
      query,
      path: scopeTarget.normalizedPath,
      results: annotated.results,
      citations: annotated.citations,
      stats,
    }
  }

  const keywordContentResults = await collectKeywordSearchResults({
    adapter,
    config,
    scopeTarget,
    scope: 'content',
    query,
    maxResults,
    caseSensitive,
    stats,
  })
  const pathResults: SuperSearchResult[] = [
    ...(await collectKeywordSearchResults({
      adapter,
      config,
      scopeTarget,
      scope: 'files',
      query,
      maxResults,
      caseSensitive,
      stats,
    })),
    ...(await collectKeywordSearchResults({
      adapter,
      config,
      scopeTarget,
      scope: 'dirs',
      query,
      maxResults,
      caseSensitive,
      stats,
    })),
  ]
  const fused = fuseRrfHybrid({
    pathResults,
    keywordResults: keywordContentResults,
    ragResults,
    maxResults,
  })
  const annotated = annotateResultsWithCitations(aggregateSearchResults({ results: fused, maxResults }))
  stats.durationMs = Math.round(performance.now() - startedAt)
  return {
    tool: 'knowledge_search',
    requestedMode,
    effectiveMode: 'hybrid',
    scope: 'content',
    query,
    path: scopeTarget.normalizedPath,
    results: annotated.results,
    citations: annotated.citations,
    stats,
  }
}
