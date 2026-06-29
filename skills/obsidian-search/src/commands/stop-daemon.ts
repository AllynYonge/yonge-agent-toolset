import { stopDaemon } from '../daemon/client.ts'
import { writeJson } from '../cli/output.ts'

export async function runStopDaemon(): Promise<void> {
  writeJson((await stopDaemon({ timeoutMs: 5000 })) ?? { ok: false, error: 'daemon unavailable' })
}
