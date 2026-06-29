#!/usr/bin/env bun
import { runSearch } from './commands/search.ts'
import { runDaemon } from './commands/daemon.ts'
import { runDaemonStatus } from './commands/daemon-status.ts'
import { runStopDaemon } from './commands/stop-daemon.ts'
import { runDoctor } from './commands/doctor.ts'

const COMMANDS: Record<string, { run: (argv: string[]) => Promise<void>; desc: string }> = {
  search:          { run: runSearch,       desc: 'Search vault by keyword, RAG, or hybrid mode' },
  daemon:          { run: runDaemon,       desc: 'Start background search daemon (preloads vector DB)' },
  'daemon:status': { run: runDaemonStatus, desc: 'Check if the daemon is running' },
  'daemon:stop':   { run: runStopDaemon,   desc: 'Stop the running daemon' },
  doctor:          { run: runDoctor,       desc: 'Diagnose config, vault path, and RAG readiness' },
}

const [command, ...argv] = Bun.argv.slice(2)

if (!command || command === '--help' || command === '-h') {
  const pad = Math.max(...Object.keys(COMMANDS).map((k) => k.length)) + 2
  const lines = Object.entries(COMMANDS)
    .map(([name, { desc }]) => `  ${name.padEnd(pad)}${desc}`)
    .join('\n')
  process.stderr.write(
    `obsidian-search — Obsidian vault knowledge retrieval CLI\n\n` +
    `Usage: obsidian-search <command> [options]\n\n` +
    `Commands:\n${lines}\n\n` +
    `Options:\n` +
    `  --query <text>          Search query\n` +
    `  --mode <mode>           keyword | rag | hybrid (default: hybrid)\n` +
    `  --scope <scope>         files | dirs | content | all (default: all)\n` +
    `  --path <path>           Vault-relative path filter\n` +
    `  --max-results <n>       Max results to return (default: 20)\n` +
    `  --format <fmt>          json | pretty\n` +
    `  --config <path>         Config file path\n` +
    `  -h, --help              Show this help message\n`,
  )
  process.exit(command ? 0 : 1)
}

const handler = COMMANDS[command]
if (!handler) {
  process.stderr.write(`Unknown command: ${command}\nRun obsidian-search --help for usage.\n`)
  process.exit(1)
}

await handler.run(argv)
