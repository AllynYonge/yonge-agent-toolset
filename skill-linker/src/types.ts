export interface SkillLinkerConfig {
  modes: Record<string, ModeConfig>;
}

export interface ModeConfig {
  skills: string[];
  mcpServers: Record<string, unknown>;
}

export interface LocalMcpServerConfig {
  type: "local";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface RemoteMcpServerConfig {
  type: "remote";
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = LocalMcpServerConfig | RemoteMcpServerConfig;

export interface LoadedConfig {
  config: SkillLinkerConfig;
  configPath: string;
  configDirectory: string;
}
