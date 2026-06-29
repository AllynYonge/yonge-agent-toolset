import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import path from 'node:path'

import type { CliArgs } from '../cli/args.ts'
import type { KnowledgeSearchConfig } from './schema.ts'

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEFAULT_CONFIG_PATH = path.join(SKILL_ROOT, 'config.json')
const EXAMPLE_CONFIG_PATH = path.join(SKILL_ROOT, 'config.example.json')

export const expandHome = (rawPath: string): string => {
  if (rawPath === '~') return homedir()
  if (rawPath.startsWith('~/')) return path.join(homedir(), rawPath.slice(2))
  return rawPath
}

const readJson = async (filePath: string): Promise<unknown> => {
  const text = await Bun.file(filePath).text()
  return JSON.parse(text) as unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const asString = (record: Record<string, unknown>, key: string): string => {
  const value = record[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`config.${key} must be a non-empty string.`)
  }
  return value
}

const asStringArray = (record: Record<string, unknown>, key: string): string[] => {
  const value = record[key]
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`config.${key} must be an array of strings.`)
  }
  return value
}

const asBoolean = (record: Record<string, unknown>, key: string): boolean => {
  const value = record[key]
  if (typeof value !== 'boolean') throw new Error(`config.${key} must be a boolean.`)
  return value
}

const asNumber = (record: Record<string, unknown>, key: string): number => {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`config.${key} must be a number.`)
  }
  return value
}

const optionalNumber = (
  record: Record<string, unknown>,
  key: string,
  defaultValue: number,
): number => {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : defaultValue
}

const normalizeMode = (value: unknown): KnowledgeSearchConfig['defaultMode'] => {
  if (value === 'keyword' || value === 'rag' || value === 'hybrid') return value
  throw new Error('config.defaultMode must be one of: keyword, rag, hybrid.')
}

const normalizeScope = (value: unknown): KnowledgeSearchConfig['defaultScope'] => {
  if (value === 'files' || value === 'dirs' || value === 'content' || value === 'all') return value
  throw new Error('config.defaultScope must be one of: files, dirs, content, all.')
}

const normalizeConfig = (raw: unknown): KnowledgeSearchConfig => {
  if (!isRecord(raw)) throw new Error('config must be a JSON object.')
  const workspaceScope = isRecord(raw.workspaceScope) ? raw.workspaceScope : {}
  const rag = isRecord(raw.rag) ? raw.rag : {}

  return {
    vaultPath: path.resolve(expandHome(asString(raw, 'vaultPath'))),
    defaultMode: normalizeMode(raw.defaultMode),
    defaultScope: normalizeScope(raw.defaultScope),
    maxResults: asNumber(raw, 'maxResults'),
    contentExtensions: asStringArray(raw, 'contentExtensions').map((extension) => extension.toLowerCase()),
    ignore: asStringArray(raw, 'ignore'),
    followSymlinks: asBoolean(raw, 'followSymlinks'),
    maxFileBytes: asNumber(raw, 'maxFileBytes'),
    workspaceScope: {
      enabled: typeof workspaceScope.enabled === 'boolean' ? workspaceScope.enabled : false,
      include: Array.isArray(workspaceScope.include)
        ? workspaceScope.include.filter((item): item is string => typeof item === 'string')
        : [],
      exclude: Array.isArray(workspaceScope.exclude)
        ? workspaceScope.exclude.filter((item): item is string => typeof item === 'string')
        : [],
    },
    rag: {
      enabled: typeof rag.enabled === 'boolean' ? rag.enabled : false,
      limit: optionalNumber(rag, 'limit', 80),
      minSimilarity: optionalNumber(rag, 'minSimilarity', 0.35),
    },
  }
}

export async function loadConfig(args: Pick<CliArgs, 'config'>): Promise<KnowledgeSearchConfig> {
  const explicitConfig = args.config ? path.resolve(expandHome(args.config)) : undefined
  const configPath = explicitConfig ?? (existsSync(DEFAULT_CONFIG_PATH) ? DEFAULT_CONFIG_PATH : EXAMPLE_CONFIG_PATH)
  return normalizeConfig(await readJson(configPath))
}
