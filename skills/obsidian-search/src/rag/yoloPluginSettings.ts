import { existsSync } from 'node:fs'
import path from 'node:path'

import type { KnowledgeSearchConfig } from '../config/schema.ts'

export type YoloProviderSettings = {
  id: string
  presetType?: string
  apiType?: string
  baseUrl?: string
  apiKey?: string
}

export type YoloEmbeddingModelSettings = {
  providerId: string
  id: string
  model: string
  name?: string
  dimension: number
  nativeDimension?: number
}

export type YoloPluginSettings = {
  providers: YoloProviderSettings[]
  embeddingModels: YoloEmbeddingModelSettings[]
  embeddingModelId: string
  ragOptions?: {
    enabled?: boolean
    minSimilarity?: number
    limit?: number
  }
  yolo?: {
    baseDir?: string
  }
}

export type YoloResolvedSettings = {
  settings: YoloPluginSettings
  pluginDir: string
  baseDir: string
  vectorDbPath: string
  runtimeDir: string
  pdfCachePath: string
}

const YOLO_PLUGIN_ID = 'yolo'
const DEFAULT_YOLO_BASE_DIR = 'YOLO'
const VECTOR_DB_FILE = '.yolo_vector_db.tar.gz'
const JSON_DB_DIR = '.yolo_json_db'
const LEGACY_VECTOR_DB_FILE = '.smtcmp_vector_db.tar.gz'
const LEGACY_JSON_DB_DIR = '.smtcmp_json_db'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const normalizeVaultRelativeDir = (raw: unknown): string => {
  if (typeof raw !== 'string') return DEFAULT_YOLO_BASE_DIR
  const trimmed = raw.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  if (!trimmed || trimmed === '.' || trimmed === '..' || trimmed.startsWith('../') || trimmed.includes('/../')) {
    return DEFAULT_YOLO_BASE_DIR
  }
  if (path.isAbsolute(trimmed)) return DEFAULT_YOLO_BASE_DIR
  return trimmed
}

const readJson = async <T>(filePath: string): Promise<T> => {
  return JSON.parse(await Bun.file(filePath).text()) as T
}

const parseSettings = (raw: unknown): YoloPluginSettings => {
  if (!isRecord(raw)) throw new Error('YOLO plugin settings must be an object.')
  const providers = Array.isArray(raw.providers) ? raw.providers.filter(isRecord) : []
  const embeddingModels = Array.isArray(raw.embeddingModels) ? raw.embeddingModels.filter(isRecord) : []
  return {
    providers: providers.map((provider) => ({
      id: String(provider.id ?? ''),
      presetType: typeof provider.presetType === 'string' ? provider.presetType : undefined,
      apiType: typeof provider.apiType === 'string' ? provider.apiType : undefined,
      baseUrl: typeof provider.baseUrl === 'string' ? provider.baseUrl : undefined,
      apiKey: typeof provider.apiKey === 'string' ? provider.apiKey : undefined,
    })),
    embeddingModels: embeddingModels.map((model) => ({
      providerId: String(model.providerId ?? ''),
      id: String(model.id ?? ''),
      model: String(model.model ?? ''),
      name: typeof model.name === 'string' ? model.name : undefined,
      dimension: typeof model.dimension === 'number' ? model.dimension : Number(model.dimension),
      nativeDimension: typeof model.nativeDimension === 'number' ? model.nativeDimension : undefined,
    })),
    embeddingModelId: typeof raw.embeddingModelId === 'string' ? raw.embeddingModelId : '',
    ragOptions: isRecord(raw.ragOptions)
      ? {
          enabled: typeof raw.ragOptions.enabled === 'boolean' ? raw.ragOptions.enabled : undefined,
          minSimilarity:
            typeof raw.ragOptions.minSimilarity === 'number' ? raw.ragOptions.minSimilarity : undefined,
          limit: typeof raw.ragOptions.limit === 'number' ? raw.ragOptions.limit : undefined,
        }
      : undefined,
    yolo: isRecord(raw.yolo)
      ? { baseDir: typeof raw.yolo.baseDir === 'string' ? raw.yolo.baseDir : undefined }
      : undefined,
  }
}

const resolveRuntimeDir = async (pluginDir: string): Promise<string> => {
  const runtimeRoot = path.join(pluginDir, 'runtime', 'pglite')
  const currentPath = path.join(runtimeRoot, 'current.json')
  const current = await readJson<{ version?: string }>(currentPath)
  if (!current.version) throw new Error('YOLO PGlite runtime current.json is missing version.')
  const runtimeDir = path.join(runtimeRoot, current.version)
  if (!existsSync(path.join(runtimeDir, 'pglite.data'))) {
    throw new Error(`YOLO PGlite runtime is incomplete: ${runtimeDir}`)
  }
  return runtimeDir
}

export async function loadYoloResolvedSettings(config: KnowledgeSearchConfig): Promise<YoloResolvedSettings> {
  const pluginDir = path.join(config.vaultPath, '.obsidian', 'plugins', YOLO_PLUGIN_ID)
  const settingsPath = path.join(pluginDir, 'data.json')
  if (!existsSync(settingsPath)) {
    throw new Error(`YOLO plugin settings not found: ${settingsPath}`)
  }
  const settings = parseSettings(await readJson<unknown>(settingsPath))
  const baseDir = normalizeVaultRelativeDir(settings.yolo?.baseDir)
  const primaryVectorDbPath = path.join(config.vaultPath, baseDir, VECTOR_DB_FILE)
  const legacyVectorDbPath = path.join(config.vaultPath, LEGACY_VECTOR_DB_FILE)
  const vectorDbPath = existsSync(primaryVectorDbPath) ? primaryVectorDbPath : legacyVectorDbPath
  if (!existsSync(vectorDbPath)) {
    throw new Error(`YOLO vector database snapshot not found: ${primaryVectorDbPath}`)
  }
  const runtimeDir = await resolveRuntimeDir(pluginDir)
  const primaryPdfCachePath = path.join(config.vaultPath, baseDir, JSON_DB_DIR, 'chats', 'pdf_cache', 'global.json')
  const legacyPdfCachePath = path.join(config.vaultPath, LEGACY_JSON_DB_DIR, 'chats', 'pdf_cache', 'global.json')
  return {
    settings,
    pluginDir,
    baseDir,
    vectorDbPath,
    runtimeDir,
    pdfCachePath: existsSync(primaryPdfCachePath) ? primaryPdfCachePath : legacyPdfCachePath,
  }
}

export function resolveEmbeddingModel(settings: YoloPluginSettings): YoloEmbeddingModelSettings {
  const model = settings.embeddingModels.find((entry) => entry.id === settings.embeddingModelId)
  if (!model) throw new Error(`Embedding model ${settings.embeddingModelId} not found in YOLO settings.`)
  if (!Number.isFinite(model.dimension) || model.dimension <= 0) {
    throw new Error(`Embedding model ${model.id} has invalid dimension.`)
  }
  return model
}

export function resolveProvider(settings: YoloPluginSettings, providerId: string): YoloProviderSettings {
  const provider = settings.providers.find((entry) => entry.id === providerId)
  if (!provider) throw new Error(`Provider ${providerId} not found in YOLO settings.`)
  return provider
}
