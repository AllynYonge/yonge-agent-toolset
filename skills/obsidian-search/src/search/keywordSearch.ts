import type { FsSearchScope } from '../cli/args.ts'
import type { KnowledgeSearchConfig } from '../config/schema.ts'
import {
  NodeFsAdapter,
  type SearchScopeTarget,
  isPathInSearchScope,
} from '../fs/nodeFsAdapter.ts'
import { isPathAllowedByScope } from '../scope/workspaceScope.ts'
import { makeContentSnippet } from './snippets.ts'
import type { SearchStats, SuperSearchResult } from './types.ts'

type MatchSummary = {
  matchedTokenCount: number
  firstMatchIndex: number
  bestMatchLength: number
}

const getQueryTokens = (queryForMatch: string): string[] => {
  const queryTokens = Array.from(
    new Set(
      queryForMatch
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 0),
    ),
  )
  return queryTokens.length > 0 ? queryTokens : queryForMatch ? [queryForMatch] : []
}

const createTokenMatcher = (query: string, caseSensitive: boolean) => {
  const queryForMatch = caseSensitive ? query : query.toLowerCase()
  const effectiveTokens = getQueryTokens(queryForMatch)

  return (sourceText: string): MatchSummary | null => {
    if (!query) {
      return { matchedTokenCount: 0, firstMatchIndex: 0, bestMatchLength: 0 }
    }

    let matchedTokenCount = 0
    let firstMatchIndex = Number.MAX_SAFE_INTEGER
    let bestMatchLength = 0

    for (const token of effectiveTokens) {
      const matchIndex = sourceText.indexOf(token)
      if (matchIndex === -1) continue
      matchedTokenCount += 1
      if (matchIndex < firstMatchIndex) {
        firstMatchIndex = matchIndex
        bestMatchLength = token.length
      }
    }

    if (matchedTokenCount === 0) return null
    return { matchedTokenCount, firstMatchIndex, bestMatchLength }
  }
}

const sortPathMatches = <T extends { path: string; match: MatchSummary }>(items: T[]): T[] => {
  return items.sort((a, b) => {
    if (a.match.matchedTokenCount !== b.match.matchedTokenCount) {
      return b.match.matchedTokenCount - a.match.matchedTokenCount
    }
    if (a.match.firstMatchIndex !== b.match.firstMatchIndex) {
      return a.match.firstMatchIndex - b.match.firstMatchIndex
    }
    return a.path.localeCompare(b.path)
  })
}

export async function collectKeywordSearchResults({
  adapter,
  config,
  scopeTarget,
  scope,
  query,
  maxResults,
  caseSensitive,
  stats,
}: {
  adapter: NodeFsAdapter
  config: KnowledgeSearchConfig
  scopeTarget: SearchScopeTarget
  scope: FsSearchScope
  query: string
  maxResults: number
  caseSensitive: boolean
  stats: SearchStats
}): Promise<SuperSearchResult[]> {
  const tokenMatcher = createTokenMatcher(query, caseSensitive)
  const getPathMatchSummary = (filePath: string): MatchSummary | null => {
    if (!query) return { matchedTokenCount: 0, firstMatchIndex: 0, bestMatchLength: 0 }
    return tokenMatcher(caseSensitive ? filePath : filePath.toLowerCase())
  }
  const includeFiles = scope === 'files' || scope === 'all'
  const includeDirs = scope === 'dirs' || scope === 'all'
  const includeContent = scope === 'content' || scope === 'all'

  if (includeContent && !query) {
    throw new Error('query is required when scope includes content.')
  }

  const results: SuperSearchResult[] = []
  const workspaceScope = config.workspaceScope

  if (includeFiles) {
    const files = (await adapter.listFiles())
      .filter((file) => isPathInSearchScope(file.path, scopeTarget))
      .filter((file) => isPathAllowedByScope(file.path, workspaceScope))
    stats.scannedFiles = Math.max(stats.scannedFiles, files.length)
    const matched = sortPathMatches(
      files
        .map((file) => ({ path: file.path, match: getPathMatchSummary(file.path) }))
        .filter((entry): entry is { path: string; match: MatchSummary } => entry.match !== null),
    )
    for (const fileEntry of matched) {
      if (results.length >= maxResults) break
      results.push({ kind: 'file', path: fileEntry.path, source: 'keyword' })
    }
  }

  if (includeDirs && results.length < maxResults) {
    const dirs = (await adapter.listDirs())
      .filter((dir) => isPathInSearchScope(dir.path, scopeTarget))
      .filter((dir) => isPathAllowedByScope(dir.path, workspaceScope))
    const matched = sortPathMatches(
      dirs
        .map((dir) => ({ path: dir.path, match: getPathMatchSummary(dir.path) }))
        .filter((entry): entry is { path: string; match: MatchSummary } => entry.match !== null),
    )
    for (const dirEntry of matched) {
      if (results.length >= maxResults) break
      results.push({ kind: 'dir', path: dirEntry.path, source: 'keyword' })
    }
  }

  if (includeContent && results.length < maxResults) {
    const searchableFiles = (await adapter.listContentFiles())
      .filter((file) => isPathInSearchScope(file.path, scopeTarget))
      .filter((file) => isPathAllowedByScope(file.path, workspaceScope))
      .sort((a, b) => a.path.localeCompare(b.path))
    stats.scannedContentFiles = searchableFiles.length
    const contentMatches: Array<{
      result: SuperSearchResult
      matchedTokenCount: number
      firstMatchIndex: number
    }> = []

    for (const file of searchableFiles) {
      if (file.size > config.maxFileBytes) {
        stats.skippedFiles.push({
          path: file.path,
          reason: `file exceeds maxFileBytes (${config.maxFileBytes})`,
        })
        continue
      }
      const content = await adapter.readText(file)
      const source = caseSensitive ? content : content.toLowerCase()
      const match = tokenMatcher(source)
      if (!match) continue
      const matchIndex = match.firstMatchIndex
      const line = content.slice(0, matchIndex).split('\n').length
      contentMatches.push({
        result: {
          kind: 'content',
          path: file.path,
          line,
          startLine: line,
          endLine: line,
          snippet: makeContentSnippet({
            content,
            matchIndex,
            matchLength: match.bestMatchLength,
          }),
          source: 'keyword',
        },
        matchedTokenCount: match.matchedTokenCount,
        firstMatchIndex: match.firstMatchIndex,
      })
    }

    contentMatches
      .sort((a, b) => {
        if (a.matchedTokenCount !== b.matchedTokenCount) {
          return b.matchedTokenCount - a.matchedTokenCount
        }
        if (a.firstMatchIndex !== b.firstMatchIndex) {
          return a.firstMatchIndex - b.firstMatchIndex
        }
        const aLine = a.result.line ?? Number.MAX_SAFE_INTEGER
        const bLine = b.result.line ?? Number.MAX_SAFE_INTEGER
        if (aLine !== bLine) return aLine - bLine
        return a.result.path.localeCompare(b.result.path)
      })
      .slice(0, Math.max(maxResults - results.length, 0))
      .forEach((item) => results.push(item.result))
  }

  return results
}
