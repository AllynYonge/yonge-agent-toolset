const normalize = (raw: string): string => raw.replace(/^\/+/, '').replace(/\/+$/, '')

function matchesRule(path: string, rule: string): boolean {
  const p = normalize(path)
  const r = normalize(rule)
  if (r === '') return true
  if (p === r) return true
  return p.startsWith(`${r}/`)
}

function matchesAny(path: string, rules: readonly string[]): boolean {
  for (const rule of rules) {
    if (matchesRule(path, rule)) return true
  }
  return false
}

export type WorkspaceScope = {
  enabled: boolean
  include: string[]
  exclude: string[]
}

export function isPathAllowedByScope(path: string, scope: WorkspaceScope | undefined): boolean {
  if (!scope || !scope.enabled) return true
  if (matchesAny(path, scope.exclude)) return false
  if (scope.include.length === 0) return true
  return matchesAny(path, scope.include)
}
