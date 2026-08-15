# @yonge/skill-linker

Link groups of SKILL directories and write project MCP configurations for Agent platforms.

## Usage

By default, the CLI searches the following locations in order:

1. `~/.yonge-skill/skill-linker.config.jsonc`
2. `~/.yonge-skill/skill-linker.config.json`
3. `skill-linker.config.jsonc` in the current working directory
4. `skill-linker.config.json` in the current working directory

JSONC comments and trailing commas are supported. Plain JSON remains compatible. See `skill-linker.config.example.jsonc` for a commented configuration example:

```jsonc
{
  // Configure one object per mode.
  "modes": {
    "dev": {
      "skills": [
        "/path/to/skills/browser",
        "../skills/documents"
      ],
      "mcpServers": {
        "filesystem": {
          "type": "local",
          "command": "npx",
          "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
          "env": {
            "NODE_ENV": "development",
            "LOG_LEVEL": "info"
          },
        },
        "context7": {
          "type": "remote",
          "url": "https://mcp.context7.com/mcp",
          "headers": {
            "Authorization": "Bearer YOUR_TOKEN",
            "X-Client-Name": "skill-linker"
          },
        }
      },
    },
  },
}
```

Each mode must contain `skills` or `mcpServers`. The previous array-only mode format is not supported. Each SKILL source directory must contain `SKILL.md`; relative source paths are resolved relative to the configuration file.

```bash
npx @yonge/skill-linker list
npx @yonge/skill-linker link dev --platform codex
npx @yonge/skill-linker link dev research --platform codex
npx @yonge/skill-linker link dev --config /path/to/skill-linker.config.json
```

The `--config` option overrides the default search for that command only.

Supported platforms are `codex`, `claude`, and `agents`. Omitting `--platform` processes all three platforms.

The `link` command accepts one or more modes. Modes are merged from left to right; a later mode replaces an earlier mode's same-name SKILL or MCP server. Repeated identical SKILL paths are deduplicated. If any requested mode does not exist, the command exits before making changes.

| Platform | SKILL directory | Project MCP config |
| --- | --- | --- |
| `codex` | `.codex/skills` | `.codex/config.toml` |
| `claude` | `.claude/skills` | `.mcp.json` |
| `agents` | `.agents/skills` | `opencode.json` |

Links are created in platform `skills` directories under the current working directory. Existing symlinks with the same name are replaced. Existing files and directories are left untouched and skipped silently. Invalid source paths and MCP definitions are skipped with a warning on stderr.

MCP configurations are merged by service name. Existing unrelated settings and MCP services are preserved; a configured service replaces an existing service with the same name. Environment variables and headers are written exactly as configured and are not expanded or printed.
