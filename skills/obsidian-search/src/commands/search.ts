import { parseCliArgs } from '../cli/args.ts'
import { writeError, writeJson } from '../cli/output.ts'
import { searchViaDaemon } from '../daemon/client.ts'
import { loadConfig } from '../config/loadConfig.ts'
import { runKnowledgeSearch } from '../search/searchService.ts'

export async function runSearch(argv: string[]): Promise<void> {
  try {
    const args = parseCliArgs(argv)
    const daemonResult = await searchViaDaemon({ args })
    if (daemonResult) {
      writeJson(daemonResult)
      return
    }
    const config = await loadConfig(args)
    const result = await runKnowledgeSearch(config, args)
    writeJson(result)
  } catch (error) {
    writeError(error)
    process.exitCode = 1
  }
}
