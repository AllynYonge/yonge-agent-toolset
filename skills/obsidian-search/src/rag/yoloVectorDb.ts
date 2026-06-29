import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite/vector'

import type { SearchScopeTarget } from '../fs/nodeFsAdapter.ts'
import type { RagEmbeddingRow } from './types.ts'
import type { YoloEmbeddingModelSettings, YoloResolvedSettings } from './yoloPluginSettings.ts'

export type RagDbModelStats = {
  model: string
  dimension: number
  chunks: number
}

type QueryResult<T> = {
  rows: T[]
}

type PGliteClient = PGlite & {
  query<T = Record<string, unknown>>(sql: string): Promise<QueryResult<T>>
  exec(sql: string): Promise<unknown>
  close?: () => Promise<void>
}

const quoteSqlString = (value: string): string => `'${value.replace(/'/g, "''")}'`

const formatNumberForVector = (value: number): string => {
  if (!Number.isFinite(value)) throw new Error('Embedding vector contains a non-finite number.')
  return String(value)
}

const formatVectorLiteral = (vector: number[]): string => `'[${vector.map(formatNumberForVector).join(',')}]'::vector`

const parseMetadata = (value: unknown): { startLine: number; endLine: number; page?: number } => {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid embedding metadata.')
  const record = parsed as Record<string, unknown>
  const startLine = Number(record.startLine)
  const endLine = Number(record.endLine)
  const page = record.page === undefined ? undefined : Number(record.page)
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
    throw new Error('Invalid embedding metadata line range.')
  }
  return {
    startLine,
    endLine,
    ...(Number.isFinite(page) ? { page } : {}),
  }
}

const createScopeSql = (scope: SearchScopeTarget): string => {
  if (scope.kind === 'vault') return ''
  if (scope.kind === 'file') return `AND path = ${quoteSqlString(scope.normalizedPath)}`
  return `AND path LIKE ${quoteSqlString(`${scope.normalizedPath}/%`)}`
}

export class YoloVectorDbReader {
  private clientPromise: Promise<PGliteClient> | null = null

  constructor(private readonly resolved: YoloResolvedSettings) {}

  private async createClient(): Promise<PGliteClient> {
    const [dbSnapshot, pgliteData, pgliteWasm, initdbWasm] = await Promise.all([
      readFile(this.resolved.vectorDbPath),
      readFile(path.join(this.resolved.runtimeDir, 'pglite.data')),
      readFile(path.join(this.resolved.runtimeDir, 'pglite.wasm')),
      readFile(path.join(this.resolved.runtimeDir, 'initdb.wasm')),
    ])
    return (await PGlite.create({
      loadDataDir: new Blob([dbSnapshot], { type: 'application/x-gzip' }),
      fsBundle: new Blob([pgliteData], { type: 'application/octet-stream' }),
      pgliteWasmModule: await WebAssembly.compile(pgliteWasm),
      initdbWasmModule: await WebAssembly.compile(initdbWasm),
      extensions: {
        vector,
      },
    })) as PGliteClient
  }

  private async getClient(): Promise<PGliteClient> {
    this.clientPromise ??= this.createClient()
    return this.clientPromise
  }

  async getModelStats(): Promise<RagDbModelStats[]> {
    const client = await this.getClient()
    const result = await client.query<RagDbModelStats>(
      'SELECT model, dimension, count(*)::int AS chunks FROM embeddings GROUP BY model, dimension ORDER BY model, dimension',
    )
    return result.rows.map((row) => ({
      model: String(row.model),
      dimension: Number(row.dimension),
      chunks: Number(row.chunks),
    }))
  }

  async hasModel(model: YoloEmbeddingModelSettings): Promise<boolean> {
    const stats = await this.getModelStats()
    return stats.some((row) => row.model === model.id && row.dimension === model.dimension && row.chunks > 0)
  }

  async similaritySearch({
    queryVector,
    model,
    minSimilarity,
    limit,
    scope,
  }: {
    queryVector: number[]
    model: YoloEmbeddingModelSettings
    minSimilarity: number
    limit: number
    scope: SearchScopeTarget
  }): Promise<RagEmbeddingRow[]> {
    const client = await this.getClient()
    await client.exec('SET hnsw.ef_search = 100')
    const vectorLiteral = formatVectorLiteral(queryVector)
    const similarityExpr = `1 - (embedding <=> ${vectorLiteral})`
    const sql = `
      SELECT
        id,
        path,
        content,
        metadata,
        ${similarityExpr} AS similarity
      FROM embeddings
      WHERE model = ${quoteSqlString(model.id)}
        AND dimension = ${model.dimension}
        AND ${similarityExpr} > ${minSimilarity}
        ${createScopeSql(scope)}
      ORDER BY similarity DESC
      LIMIT ${limit}
    `
    const result = await client.query<{
      path: string
      content: string
      metadata: unknown
      similarity: number
    }>(sql)
    return result.rows.map((row) => ({
      path: String(row.path),
      content: String(row.content),
      metadata: parseMetadata(row.metadata),
      similarity: Number(row.similarity),
    }))
  }

  async close(): Promise<void> {
    if (!this.clientPromise) return
    const client = await this.clientPromise
    await client.close?.()
    this.clientPromise = null
  }
}
