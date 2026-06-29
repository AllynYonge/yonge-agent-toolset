import { CitationRegistry } from './citationRegistry.ts'
import { superSearchDedupKey } from '../search/hybridSearch.ts'
import type { AggregatedSearchResult, SuperSearchResult } from '../search/types.ts'

const snippetToDedupResult = (path: string, snippet: NonNullable<Extract<AggregatedSearchResult, { kind: 'content_group' }>['snippets'][number]>): SuperSearchResult => ({
  kind: 'content',
  path,
  line: snippet.line,
  startLine: snippet.startLine,
  endLine: snippet.endLine,
  page: snippet.page,
  snippet: snippet.snippet,
  source: snippet.source,
  similarity: snippet.similarity,
  rrfScore: snippet.rrfScore,
})

export type OutputCitation = {
  cite: number
  path: string
  startLine?: number
  endLine?: number
  page?: number
  snippet: string
  similarity?: number
  source: 'rag' | 'keyword' | 'hybrid'
}

export function annotateResultsWithCitations(results: AggregatedSearchResult[]): {
  results: AggregatedSearchResult[]
  citations: OutputCitation[]
} {
  const registry = new CitationRegistry()
  const annotated = results.map((result): AggregatedSearchResult => {
    if (result.kind !== 'content_group') return result
    return {
      ...result,
      snippets: result.snippets.map((snippet) => {
        const citationSnippet = snippet.snippet ?? ''
        const cite = registry.assign(superSearchDedupKey(snippetToDedupResult(result.path, snippet)), {
          path: result.path,
          startLine: snippet.startLine ?? snippet.line,
          endLine: snippet.endLine ?? snippet.line,
          page: snippet.page,
          snippet: citationSnippet,
          similarity: snippet.similarity,
          source: snippet.source,
        })
        return { ...snippet, cite }
      }),
    }
  })
  return {
    results: annotated,
    citations: registry.toArray().map(({ ordinal, ...citation }) => ({
      cite: ordinal,
      ...citation,
    })),
  }
}
