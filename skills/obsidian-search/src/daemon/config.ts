export const DEFAULT_DAEMON_HOST = '127.0.0.1'
export const DEFAULT_DAEMON_PORT = 47783

export type DaemonConfig = {
  host: string
  port: number
}

export const getDaemonBaseUrl = (config: DaemonConfig): string => {
  return `http://${config.host}:${config.port}`
}
