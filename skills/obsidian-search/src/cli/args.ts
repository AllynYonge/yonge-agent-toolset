export type FsSearchMode = 'keyword' | 'rag' | 'hybrid'
export type FsSearchScope = 'files' | 'dirs' | 'content' | 'all'
export type OutputFormat = 'json' | 'pretty'

export type CliArgs = {
  config?: string
  query?: string
  mode?: FsSearchMode
  scope?: FsSearchScope
  path?: string
  maxResults?: number
  caseSensitive?: boolean
  ragMinSimilarity?: number
  ragLimit?: number
  format?: OutputFormat
  workspaceInclude: string[]
  workspaceExclude: string[]
}

const readValue = (
  argv: string[],
  index: number,
  flag: string,
): { value: string; nextIndex: number } => {
  const inlinePrefix = `${flag}=`
  const token = argv[index]
  if (token.startsWith(inlinePrefix)) {
    return { value: token.slice(inlinePrefix.length), nextIndex: index }
  }
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`)
  }
  return { value, nextIndex: index + 1 }
}

const parseMode = (value: string): FsSearchMode => {
  if (value === 'keyword' || value === 'rag' || value === 'hybrid') return value
  throw new Error('--mode must be one of: keyword, rag, hybrid.')
}

const parseScope = (value: string): FsSearchScope => {
  if (value === 'files' || value === 'dirs' || value === 'content' || value === 'all') {
    return value
  }
  throw new Error('--scope must be one of: files, dirs, content, all.')
}

const parseFormat = (value: string): OutputFormat => {
  if (value === 'json' || value === 'pretty') return value
  throw new Error('--format must be one of: json, pretty.')
}

const parseInteger = (value: string, flag: string): number => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) {
    throw new Error(`${flag} must be an integer.`)
  }
  return parsed
}

const parseNumber = (value: string, flag: string): number => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`${flag} must be a number.`)
  }
  return parsed
}

export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    workspaceInclude: [],
    workspaceExclude: [],
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]

    if (token === '--case-sensitive') {
      args.caseSensitive = true
      continue
    }

    if (token === '--help' || token === '-h') {
      args.format = 'pretty'
      args.query = args.query ?? ''
      continue
    }

    const consume = (flag: string): string => {
      const result = readValue(argv, index, flag)
      index = result.nextIndex
      return result.value
    }

    if (token === '--config' || token.startsWith('--config=')) {
      args.config = consume('--config')
    } else if (token === '--query' || token.startsWith('--query=')) {
      args.query = consume('--query')
    } else if (token === '--mode' || token.startsWith('--mode=')) {
      args.mode = parseMode(consume('--mode'))
    } else if (token === '--scope' || token.startsWith('--scope=')) {
      args.scope = parseScope(consume('--scope'))
    } else if (token === '--path' || token.startsWith('--path=')) {
      args.path = consume('--path')
    } else if (token === '--max-results' || token.startsWith('--max-results=')) {
      args.maxResults = parseInteger(consume('--max-results'), '--max-results')
    } else if (token === '--rag-min-similarity' || token.startsWith('--rag-min-similarity=')) {
      args.ragMinSimilarity = parseNumber(consume('--rag-min-similarity'), '--rag-min-similarity')
    } else if (token === '--rag-limit' || token.startsWith('--rag-limit=')) {
      args.ragLimit = parseInteger(consume('--rag-limit'), '--rag-limit')
    } else if (token === '--format' || token.startsWith('--format=')) {
      args.format = parseFormat(consume('--format'))
    } else if (token === '--workspace-include' || token.startsWith('--workspace-include=')) {
      args.workspaceInclude.push(consume('--workspace-include'))
    } else if (token === '--workspace-exclude' || token.startsWith('--workspace-exclude=')) {
      args.workspaceExclude.push(consume('--workspace-exclude'))
    } else {
      throw new Error(`Unknown argument: ${token}`)
    }
  }

  return args
}
