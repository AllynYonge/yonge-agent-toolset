import { describe, expect, it } from 'bun:test'

import { fuseRrfHybrid, superSearchDedupKey } from '../src/search/hybridSearch.ts'
import type { SuperSearchResult } from '../src/search/types.ts'

describe('hybridSearch RRF', () => {
  const kw = (path: string, line: number): SuperSearchResult => ({
    kind: 'content',
    path,
    line,
    startLine: line,
    endLine: line,
    snippet: 'k',
    source: 'keyword',
  })

  const rag = (path: string, startLine: number, endLine: number, similarity: number): SuperSearchResult => ({
    kind: 'content',
    path,
    line: startLine,
    startLine,
    endLine,
    snippet: 'r',
    similarity,
    source: 'rag',
  })

  it('merges duplicate keys and boosts dual hits', () => {
    const fused = fuseRrfHybrid({
      keywordResults: [kw('a.md', 1), kw('b.md', 2)],
      ragResults: [rag('a.md', 1, 1, 0.9), rag('c.md', 5, 6, 0.8)],
      maxResults: 10,
    })
    expect(fused[0].path).toBe('a.md')
    expect(fused[0].source).toBe('hybrid')
    expect(fused[0].rrfScore).toBeGreaterThan(0)
  })

  it('does not return path-only hits when there is no content hit', () => {
    const fused = fuseRrfHybrid({
      pathResults: [{ kind: 'file', path: 'a.md', source: 'keyword' }],
      keywordResults: [],
      ragResults: [],
      maxResults: 10,
    })
    expect(fused).toEqual([])
  })

  it('dedup key matches content line range', () => {
    const a: SuperSearchResult = {
      kind: 'content',
      path: 'x.md',
      line: 3,
      startLine: 3,
      endLine: 5,
      snippet: '',
      source: 'rag',
    }
    const b: SuperSearchResult = { ...a, source: 'keyword' }
    expect(superSearchDedupKey(a)).toBe(superSearchDedupKey(b))
  })
})
