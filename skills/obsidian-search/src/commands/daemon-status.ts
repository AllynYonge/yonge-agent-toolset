import { daemonStatus } from '../daemon/client.ts'
import { writeJson } from '../cli/output.ts'

export async function runDaemonStatus(): Promise<void> {
  writeJson((await daemonStatus({ timeoutMs: 1000 })) ?? { ok: false, error: 'daemon unavailable' })
}
