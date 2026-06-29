import type { CliArgs } from '../cli/args.ts'
import type { KnowledgeSearchResponse } from '../search/searchService.ts'
import { DEFAULT_DAEMON_HOST, DEFAULT_DAEMON_PORT, getDaemonBaseUrl } from './config.ts'

export type DaemonSearchRequest = {
  args: CliArgs
}

export async function searchViaDaemon({
  args,
  timeoutMs = 120000,
}: {
  args: CliArgs
  timeoutMs?: number
}): Promise<KnowledgeSearchResponse | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(
      `${getDaemonBaseUrl({ host: DEFAULT_DAEMON_HOST, port: DEFAULT_DAEMON_PORT })}/search`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args } satisfies DaemonSearchRequest),
        signal: controller.signal,
      },
    )
    if (!response.ok) return null
    return (await response.json()) as KnowledgeSearchResponse
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
export async function daemonStatus({ timeoutMs = 1000 }: { timeoutMs?: number } = {}): Promise<unknown | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(
      `${getDaemonBaseUrl({ host: DEFAULT_DAEMON_HOST, port: DEFAULT_DAEMON_PORT })}/status`,
      { signal: controller.signal },
    )
    if (!response.ok) return null
    return response.json() as Promise<unknown>
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function stopDaemon({ timeoutMs = 5000 }: { timeoutMs?: number } = {}): Promise<unknown | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(
      `${getDaemonBaseUrl({ host: DEFAULT_DAEMON_HOST, port: DEFAULT_DAEMON_PORT })}/shutdown`,
      { method: 'POST', signal: controller.signal },
    )
    if (!response.ok) return null
    return response.json() as Promise<unknown>
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
