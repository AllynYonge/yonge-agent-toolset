import type { YoloEmbeddingModelSettings, YoloProviderSettings } from './yoloPluginSettings.ts'

type EmbeddingResponseShape = Record<string, unknown>

export const extractEmbeddingVector = (response: unknown): number[] => {
  if (Array.isArray(response) && response.length > 0) {
    if (response.every((value) => typeof value === 'number')) return response
    const first = response[0] as EmbeddingResponseShape
    if (Array.isArray(first.embedding)) return first.embedding as number[]
  }

  if (response && typeof response === 'object') {
    const record = response as EmbeddingResponseShape
    const data = record.data
    if (Array.isArray(data) && data.length > 0) {
      const first = data[0] as EmbeddingResponseShape
      if (Array.isArray(first.embedding)) return first.embedding as number[]
    }
    if (data && typeof data === 'object') {
      const dataRecord = data as EmbeddingResponseShape
      if (Array.isArray(dataRecord.embedding)) return dataRecord.embedding as number[]
    }
    if (Array.isArray(record.embedding)) return record.embedding as number[]
  }

  throw new Error('Embedding model returned an invalid result.')
}

export async function embedText({
  provider,
  model,
  text,
}: {
  provider: YoloProviderSettings
  model: YoloEmbeddingModelSettings
  text: string
}): Promise<number[]> {
  if (!provider.baseUrl) throw new Error(`Provider ${provider.id} is missing baseUrl.`)
  if (!provider.apiKey) throw new Error(`Provider ${provider.id} is missing apiKey.`)
  const shouldSendDimensions = model.nativeDimension != null && model.dimension !== model.nativeDimension
  const response = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/embeddings`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${provider.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: model.model,
      input: text,
      encoding_format: 'float',
      ...(shouldSendDimensions ? { dimensions: model.dimension } : {}),
    }),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Embedding request failed (${response.status}): ${body.slice(0, 500)}`)
  }
  const vector = extractEmbeddingVector(await response.json())
  if (vector.length !== model.dimension) {
    throw new Error(
      `Embedding model "${model.id}" returned ${vector.length}-dimensional vector, expected ${model.dimension}.`,
    )
  }
  return vector
}
