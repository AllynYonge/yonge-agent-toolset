import type { Platform } from "./platform.js";

export interface SkillLinkerConfig {
  modes: Record<string, ModeConfig>;
}

export interface BaseInstructionEntry {
  PATH: string;
  NAME: string;
}

export type BaseInstructionConfig = Partial<Record<Platform, BaseInstructionEntry>>;

export interface ModeConfig {
  skills: string[];
  mcpServers: Record<string, unknown>;
  baseInstruction: BaseInstructionConfig;
}

export interface LocalMcpServerConfig {
  type: "local";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  startup_timeout_sec?: number;
}

export interface McpOAuthConfig {
  clientId: string;
}

export interface RemoteMcpServerConfig {
  type: "remote";
  url: string;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig;
  startup_timeout_sec?: number;
}

export type McpServerConfig = LocalMcpServerConfig | RemoteMcpServerConfig;

export interface LoadedConfig {
  config: SkillLinkerConfig;
  configPath: string;
  configDirectory: string;
}
