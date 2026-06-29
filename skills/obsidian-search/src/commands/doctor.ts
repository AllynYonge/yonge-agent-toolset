import { existsSync } from 'node:fs'

import { parseCliArgs } from '../cli/args.ts'
import { writeJson } from '../cli/output.ts'
import { loadConfig } from '../config/loadConfig.ts'
import { pathExistsAndIsDirectory } from '../fs/nodeFsAdapter.ts'
import { YoloVectorDbReader } from '../rag/yoloVectorDb.ts'
import {
  loadYoloResolvedSettings,
  resolveEmbeddingModel,
} from '../rag/yoloPluginSettings.ts'

export async function runDoctor(argv: string[]): Promise<void> {
  const args = parseCliArgs(argv)
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []

  checks.push({ name: 'bun', ok: true, detail: Bun.version })

  try {
    const config = await loadConfig(args)
    checks.push({
      name: 'vaultPath',
      ok: await pathExistsAndIsDirectory(config.vaultPath),
      detail: config.vaultPath,
    })
    checks.push({
      name: 'config',
      ok: args.config ? existsSync(args.config) : true,
      detail: args.config ?? 'default search paths',
    })
    if (config.rag.enabled) {
      const resolved = await loadYoloResolvedSettings(config)
      checks.push({ name: 'yoloSettings', ok: true, detail: resolved.pluginDir })
      checks.push({ name: 'vectorDb', ok: existsSync(resolved.vectorDbPath), detail: resolved.vectorDbPath })
      checks.push({ name: 'pgliteRuntime', ok: true, detail: resolved.runtimeDir })
      const embeddingModel = resolveEmbeddingModel(resolved.settings)
      const reader = new YoloVectorDbReader(resolved)
      const stats = await reader.getModelStats()
      await reader.close()
      checks.push({
        name: 'embeddingModel',
        ok: stats.some(
          (row) =>
            row.model === embeddingModel.id &&
            row.dimension === embeddingModel.dimension &&
            row.chunks > 0,
        ),
        detail: `${embeddingModel.id}/${embeddingModel.dimension}; available=${stats
          .map((row) => `${row.model}/${row.dimension}:${row.chunks}`)
          .join(', ')}`,
      })
    } else {
      checks.push({ name: 'rag', ok: true, detail: 'disabled' })
    }
    writeJson({ ok: checks.every((check) => check.ok), checks })
  } catch (error) {
    checks.push({
      name: 'config',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    })
    writeJson({ ok: false, checks })
    process.exitCode = 1
  }
}
