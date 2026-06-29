import { describe, expect, it } from 'bun:test'

import { aggregateSearchResults } from '../src/search/resultAggregation.ts'
import type { SuperSearchResult } from '../src/search/types.ts'

describe('aggregateSearchResults', () => {
  const hit = (path: string, startLine: number, endLine: number, rrfScore: number): SuperSearchResult => ({
    kind: 'content',
    path,
    line: startLine,
    startLine,
    endLine,
    snippet: `${path}:${startLine}-${endLine}`,
    source: 'hybrid',
    rrfScore,
    matchType: 'content',
  })

  it('groups multiple content hits from the same file and keeps top snippets', () => {
    const results = aggregateSearchResults({
      results: [hit('a.md', 1, 2, 0.02), hit('b.md', 4, 6, 0.018), hit('a.md', 10, 12, 0.017)],
      maxResults: 10,
    })
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ kind: 'content_group', path: 'a.md', hitCount: 2 })
    if (results[0].kind !== 'content_group') throw new Error('expected content_group')
    expect(results[0].snippets).toHaveLength(2)
  })

  it('preserves file results and mixed ordering', () => {
    const results = aggregateSearchResults({
      results: [
        { kind: 'file', path: 'docs/a.md', source: 'keyword' },
        hit('docs/a.md', 8, 10, 0.02),
        { kind: 'dir', path: 'docs/sub', source: 'keyword' },
      ],
      maxResults: 10,
    })
    expect(results).toMatchObject([
      { kind: 'file', path: 'docs/a.md' },
      { kind: 'content_group', path: 'docs/a.md' },
      { kind: 'dir', path: 'docs/sub' },
    ])
  })
})
