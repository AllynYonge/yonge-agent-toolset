import type { VectorMetaData } from './types.ts'

export type ReconcileScope = { kind: 'all' } | { kind: 'paths'; paths: string[] }

export type DesiredChunk = {
  path: string
  content: string
  contentHash: string
  metadata: VectorMetaData
  mtime: number
}

export type ActualChunk = {
  id: number
  path: string
  contentHash: string | null
  metadata: VectorMetaData
  mtime: number
}

export type ReconcilePlan = {
  toDeleteIds: number[]
  toEmbed: DesiredChunk[]
  toBumpMtime: Array<{ id: number; mtime: number }>
  reusedCount: number
}

const identityWithinPath = (meta: VectorMetaData): string => {
  const page = meta.page === undefined ? '' : `p${meta.page}:`
  return `${page}${meta.startLine}-${meta.endLine}`
}

const fullIdentity = (filePath: string, meta: VectorMetaData): string => `${filePath}#${identityWithinPath(meta)}`

export function planReconcile(desired: DesiredChunk[], actual: ActualChunk[]): ReconcilePlan {
  const desiredByIdentity = new Map<string, DesiredChunk>()
  for (const item of desired) desiredByIdentity.set(fullIdentity(item.path, item.metadata), item)

  const actualByIdentity = new Map<string, ActualChunk[]>()
  for (const item of actual) {
    const key = fullIdentity(item.path, item.metadata)
    const bucket = actualByIdentity.get(key)
    if (bucket) bucket.push(item)
    else actualByIdentity.set(key, [item])
  }

  const toDeleteIds: number[] = []
  const toEmbed: DesiredChunk[] = []
  const toBumpMtime: Array<{ id: number; mtime: number }> = []
  let reusedCount = 0

  for (const [key, rows] of actualByIdentity) {
    const desiredChunk = desiredByIdentity.get(key)
    if (!desiredChunk) {
      for (const row of rows) toDeleteIds.push(row.id)
      continue
    }
    const matching = rows.find((row) => row.contentHash === desiredChunk.contentHash)
    if (matching) {
      reusedCount += 1
      if (matching.mtime !== desiredChunk.mtime) {
        toBumpMtime.push({ id: matching.id, mtime: desiredChunk.mtime })
      }
      for (const row of rows) if (row.id !== matching.id) toDeleteIds.push(row.id)
    } else {
      for (const row of rows) toDeleteIds.push(row.id)
    }
  }

  for (const [key, desiredChunk] of desiredByIdentity) {
    const rows = actualByIdentity.get(key)
    if (!rows) {
      toEmbed.push(desiredChunk)
      continue
    }
    const matching = rows.find((row) => row.contentHash === desiredChunk.contentHash)
    if (!matching) toEmbed.push(desiredChunk)
  }

  return { toDeleteIds, toEmbed, toBumpMtime, reusedCount }
}
