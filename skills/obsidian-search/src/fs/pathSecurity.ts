import path from 'node:path'

const normalizeSeparators = (rawPath: string): string => rawPath.replace(/\\/g, '/')

export const normalizeVaultRelativePath = (rawPath: string | undefined): string => {
  const trimmed = normalizeSeparators(rawPath?.trim() ?? '').replace(/^\/+/, '').replace(/\/+$/, '')
  if (!trimmed || trimmed === '.') return ''
  if (path.isAbsolute(trimmed)) {
    throw new Error('--path must be vault-relative, not absolute.')
  }
  const normalized = path.posix.normalize(trimmed)
  if (normalized === '.' || normalized === '/') return ''
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error('--path must stay inside the configured vault.')
  }
  return normalized.replace(/^\/+/, '').replace(/\/+$/, '')
}

export const resolveVaultPath = (vaultRoot: string, relativePath: string): string => {
  const normalizedRelative = normalizeVaultRelativePath(relativePath)
  const absolutePath = path.resolve(vaultRoot, normalizedRelative)
  const relativeToRoot = path.relative(vaultRoot, absolutePath)
  if (relativeToRoot === '..' || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
    throw new Error('Resolved path escapes the configured vault.')
  }
  return absolutePath
}

export const toVaultRelativePath = (vaultRoot: string, absolutePath: string): string => {
  const relative = path.relative(vaultRoot, absolutePath)
  if (relative === '') return ''
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Path escapes the configured vault.')
  }
  return normalizeSeparators(relative)
}
