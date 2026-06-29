import { parseCliArgs } from '../cli/args.ts'
import { loadConfig } from '../config/loadConfig.ts'
import { DEFAULT_DAEMON_HOST, DEFAULT_DAEMON_PORT } from '../daemon/config.ts'
import { YoloRagSession } from '../rag/ragSearch.ts'
import { runKnowledgeSearch } from '../search/searchService.ts'

type JsonResponseInit = {
  status?: number
}

const jsonResponse = (value: unknown, init: JsonResponseInit = {}): Response => {
  return new Response(`${JSON.stringify(value, null, 2)}\n`, {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  })
}

export async function runDaemon(argv: string[]): Promise<void> {
  const args = parseCliArgs(argv)
  const config = await loadConfig(args)
  const startedAt = Date.now()
  const ragSession = await YoloRagSession.create(config)

  const server = Bun.serve({
    hostname: DEFAULT_DAEMON_HOST,
    port: DEFAULT_DAEMON_PORT,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method === 'GET' && url.pathname === '/status') {
        return jsonResponse({
          ok: true,
          pid: process.pid,
          uptimeMs: Date.now() - startedAt,
          host: DEFAULT_DAEMON_HOST,
          port: DEFAULT_DAEMON_PORT,
          vaultPath: config.vaultPath,
        })
      }
      if (request.method === 'POST' && url.pathname === '/search') {
        try {
          const body = (await request.json()) as { args?: unknown }
          const requestArgs = body.args && typeof body.args === 'object' ? body.args : {}
          const result = await runKnowledgeSearch(config, requestArgs as Parameters<typeof runKnowledgeSearch>[1], {
            ragSearch: (ragRequest) => ragSession.search(ragRequest),
          })
          return jsonResponse(result)
        } catch (error) {
          return jsonResponse(
            { ok: false, error: error instanceof Error ? error.message : String(error) },
            { status: 500 },
          )
        }
      }
      if (request.method === 'POST' && url.pathname === '/shutdown') {
        setTimeout(() => void shutdown(), 0)
        return jsonResponse({ ok: true, message: 'obsidian-search daemon stopping', pid: process.pid })
      }
      return jsonResponse({ ok: false, error: 'not found' }, { status: 404 })
    },
  })

  const shutdown = async (): Promise<void> => {
    await ragSession.close()
    server.stop(true)
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())

  process.stderr.write(
    `obsidian-search daemon listening on http://${DEFAULT_DAEMON_HOST}:${DEFAULT_DAEMON_PORT}\n`,
  )
}
