import { lstat, readdir, stat } from 'node:fs/promises'

import type { KnowledgeSearchConfig } from '../config/schema.ts'
import { hasContentExtension, isIgnoredPath } from './fileTypes.ts'
import { normalizeVaultRelativePath, resolveVaultPath, toVaultRelativePath } from './pathSecurity.ts'

export type VaultFile = {
  kind: 'file'
  path: string
  absolutePath: string
  size: number
  mtime: number
}

export type VaultDir = {
  kind: 'dir'
  path: string
  absolutePath: string
}

export type SearchScopeTarget =
  | { kind: 'vault'; normalizedPath: string }
  | { kind: 'folder'; normalizedPath: string; absolutePath: string }
  | { kind: 'file'; normalizedPath: string; absolutePath: string }

export const pathExistsAndIsDirectory = async (absolutePath: string): Promise<boolean> => {
  try {
    return (await stat(absolutePath)).isDirectory()
  } catch {
    return false
  }
}

export const isPathInSearchScope = (filePath: string, scope: SearchScopeTarget): boolean => {
  if (scope.kind === 'vault') return true
  if (scope.kind === 'folder') {
    return filePath === scope.normalizedPath || filePath.startsWith(`${scope.normalizedPath}/`)
  }
  return filePath === scope.normalizedPath
}

export const resolveSearchScopeByPath = async (
  config: KnowledgeSearchConfig,
  rawPath: string | undefined,
): Promise<SearchScopeTarget> => {
  const normalizedPath = normalizeVaultRelativePath(rawPath)
  if (!normalizedPath) return { kind: 'vault', normalizedPath: '' }
  const absolutePath = resolveVaultPath(config.vaultPath, normalizedPath)
  const entryStat = await stat(absolutePath).catch(() => null)
  if (!entryStat) throw new Error(`Path not found: ${normalizedPath}`)
  if (entryStat.isDirectory()) return { kind: 'folder', normalizedPath, absolutePath }
  if (entryStat.isFile()) return { kind: 'file', normalizedPath, absolutePath }
  throw new Error(`Unsupported path target: ${normalizedPath}`)
}

export class NodeFsAdapter {
  constructor(private readonly config: KnowledgeSearchConfig) {}

  async listFiles(): Promise<VaultFile[]> {
    const files: VaultFile[] = []
    await this.walk(this.config.vaultPath, files, [])
    return files.sort((a, b) => a.path.localeCompare(b.path))
  }

  async listDirs(): Promise<VaultDir[]> {
    const dirs: VaultDir[] = []
    await this.walkDirs(this.config.vaultPath, dirs)
    return dirs.sort((a, b) => a.path.localeCompare(b.path))
  }

  async listContentFiles(): Promise<VaultFile[]> {
    return (await this.listFiles()).filter((file) => hasContentExtension(file.path, this.config.contentExtensions))
  }

  async readText(file: VaultFile): Promise<string> {
    return Bun.file(file.absolutePath).text()
  }

  private async walk(currentPath: string, files: VaultFile[], visitedRealPaths: string[]): Promise<void> {
    const entries = await readdir(currentPath, { withFileTypes: true })
    for (const entry of entries) {
      const absolutePath = `${currentPath}/${entry.name}`
      const relativePath = toVaultRelativePath(this.config.vaultPath, absolutePath)
      if (isIgnoredPath(relativePath, this.config.ignore)) continue
      const entryLstat = await lstat(absolutePath)
      if (entryLstat.isSymbolicLink() && !this.config.followSymlinks) continue
      if (entryLstat.isDirectory()) {
        await this.walk(absolutePath, files, visitedRealPaths)
        continue
      }
      if (!entryLstat.isFile()) continue
      files.push({
        kind: 'file',
        path: relativePath,
        absolutePath,
        size: entryLstat.size,
        mtime: entryLstat.mtimeMs,
      })
    }
    void visitedRealPaths
  }

  private async walkDirs(currentPath: string, dirs: VaultDir[]): Promise<void> {
    const entries = await readdir(currentPath, { withFileTypes: true })
    for (const entry of entries) {
      const absolutePath = `${currentPath}/${entry.name}`
      const relativePath = toVaultRelativePath(this.config.vaultPath, absolutePath)
      if (isIgnoredPath(relativePath, this.config.ignore)) continue
      const entryLstat = await lstat(absolutePath)
      if (entryLstat.isSymbolicLink() && !this.config.followSymlinks) continue
      if (!entryLstat.isDirectory()) continue
      dirs.push({ kind: 'dir', path: relativePath, absolutePath })
      await this.walkDirs(absolutePath, dirs)
    }
  }
}
