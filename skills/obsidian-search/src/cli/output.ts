export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

export function writeError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  writeJson({ ok: false, error: message })
}
