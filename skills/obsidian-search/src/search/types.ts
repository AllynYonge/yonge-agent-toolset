export type SuperSearchResultSource = 'keyword' | 'rag' | 'hybrid'
export type SuperSearchMatchType = 'dual' | 'content' | 'path'

export type SuperSearchResult = {
  kind: 'file' | 'dir' | 'content'
  path: string
  line?: number
  startLine?: number
  endLine?: number
  page?: number
  snippet?: string
  source: SuperSearchResultSource
  matchType?: SuperSearchMatchType
  similarity?: number
  rrfScore?: number
}

export type AggregatedSearchSnippet = {
  cite?: number
  line?: number
  startLine?: number
  endLine?: number
  page?: number
  snippet?: string
  source: SuperSearchResultSource
  similarity?: number
  rrfScore?: number
}

export type AggregatedContentSearchResult = {
  kind: 'content_group'
  path: string
  source: SuperSearchResultSource
  matchType?: SuperSearchMatchType
  score: number
  hitCount: number
  snippets: AggregatedSearchSnippet[]
}

type NonContentSearchResult = {
  kind: 'file' | 'dir'
  path: string
  source: SuperSearchResultSource
}

export type AggregatedSearchResult = NonContentSearchResult | AggregatedContentSearchResult

export type SearchStats = {
  scannedFiles: number
  scannedContentFiles: number
  skippedFiles: Array<{ path: string; reason: string }>
  durationMs: number
}
