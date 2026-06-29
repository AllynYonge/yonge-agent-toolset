export const hasContentExtension = (filePath: string, extensions: readonly string[]): boolean => {
  const lowerPath = filePath.toLowerCase()
  return extensions.some((extension) => lowerPath.endsWith(extension.toLowerCase()))
}

const segmentMatches = (patternSegment: string, pathSegment: string): boolean => {
  if (patternSegment === '*') return true
  if (!patternSegment.includes('*')) return patternSegment === pathSegment
  const escaped = patternSegment
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${escaped}$`).test(pathSegment)
}

const matchSegments = (patternSegments: string[], pathSegments: string[]): boolean => {
  if (patternSegments.length === 0) return pathSegments.length === 0
  const [head, ...tail] = patternSegments
  if (head === '**') {
    if (tail.length === 0) return true
    for (let index = 0; index <= pathSegments.length; index += 1) {
      if (matchSegments(tail, pathSegments.slice(index))) return true
    }
    return false
  }
  if (pathSegments.length === 0) return false
  return segmentMatches(head, pathSegments[0]) && matchSegments(tail, pathSegments.slice(1))
}

export const matchesIgnorePattern = (relativePath: string, pattern: string): boolean => {
  const normalizedPattern = pattern.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  const normalizedPath = relativePath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  if (!normalizedPattern) return false
  if (normalizedPattern.endsWith('/**')) {
    const prefix = normalizedPattern.slice(0, -3)
    return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)
  }
  return matchSegments(normalizedPattern.split('/'), normalizedPath.split('/'))
}

export const isIgnoredPath = (relativePath: string, patterns: readonly string[]): boolean => {
  return patterns.some((pattern) => matchesIgnorePattern(relativePath, pattern))
}
