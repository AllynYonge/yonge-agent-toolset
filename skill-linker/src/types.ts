export interface SkillLinkerConfig {
  modes: Record<string, string[]>;
}

export interface LoadedConfig {
  config: SkillLinkerConfig;
  configPath: string;
  configDirectory: string;
}
