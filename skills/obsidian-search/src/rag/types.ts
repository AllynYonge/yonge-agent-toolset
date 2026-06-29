export type VectorMetaData = {
  startLine: number
  endLine: number
  page?: number
}

export type RagEmbeddingRow = {
  path: string
  content: string
  metadata: VectorMetaData
  similarity: number
}
