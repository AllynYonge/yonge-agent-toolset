# @yonge/skill-linker

Link groups of SKILL directories and write project MCP configurations for Agent platforms.

## Usage

By default, the CLI searches the following locations in order:

1. `~/.yonge/linker.config.jsonc`
2. `~/.yonge/linker.config.json`
3. `linker.config.jsonc` in the current working directory
4. `linker.config.json` in the current working directory

JSONC comments and trailing commas are supported. Plain JSON remains compatible. See `linker.config.example.jsonc` for a commented configuration example:

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
          "startup_timeout_sec": 120,
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

      "baseInstruction": {
        "claude": { "PATH": "../CLAUDE.md", "NAME": "CLAUDE.md" },
        "codex": { "PATH": "../AGENTS.md", "NAME": "AGENTS.md" },
        "agents": { "PATH": "../AGENTS.md", "NAME": "AGENTS.md" }
      }
    },
  },
}
```

Each mode must contain `skills`, `mcpServers`, or `baseInstruction`. The previous array-only mode format is not supported. Each SKILL source directory must contain `SKILL.md`; relative source paths are resolved relative to the configuration file.

A `baseInstruction` entry supports only the platform keys `codex`, `claude`, and `agents`, and each entry supports only non-empty `PATH` and `NAME` fields. `PATH` must point to a file. `NAME` must be a single filename. Relative `PATH` values are resolved relative to the configuration file.

```bash
npx @yonge/skill-linker list
npx @yonge/skill-linker link dev --platform codex
npx @yonge/skill-linker link dev research --platform codex
npx @yonge/skill-linker link dev --config /path/to/linker.config.json
```

The `--config` option overrides the default search for that command only.

Supported platforms are `codex`, `claude`, and `agents`. Omitting `--platform` processes all three platforms.

The `link` command accepts one or more modes. Modes are merged from left to right; a later mode replaces an earlier mode's same-name SKILL, MCP server, or same-platform base instruction. Repeated identical SKILL paths are deduplicated. If any requested mode does not exist, the command exits before making changes.

| Platform | SKILL directory | Project MCP config | Base instruction link |
| --- | --- | --- | --- |
| `codex` | `.codex/skills` | `.codex/config.toml` | Project root `NAME` |
| `claude` | `.claude/skills` | `.mcp.json` | `.claude/NAME` |
| `agents` | `.agents/skills` | `.pi/mcp.json` | Project root `NAME` |

The `agents` platform targets the tool-agnostic `.agents/skills` directory and Pi's project MCP override `.pi/mcp.json`, which takes precedence over `.mcp.json`.

Links are created in platform `skills` directories under the current working directory. Existing symlinks with the same name are replaced. Existing files and directories are left untouched and skipped silently. Invalid source paths and MCP definitions are skipped with a warning on stderr.

MCP configurations are merged by service name. Existing unrelated settings and MCP services are preserved; a configured service replaces an existing service with the same name. Environment variables and headers are written exactly as configured and are not expanded or printed.

Both local and remote MCP entries accept an optional `startup_timeout_sec` positive integer. Codex writes it as `startup_timeout_sec` in seconds. Claude Code and the `agents` platform ignore it because neither target format has an equivalent per-server startup timeout field.

Remote MCP entries accept an optional `oauth` object with a required non-empty `clientId` string, used to pin a pre-registered OAuth client instead of letting the platform register one dynamically. `oauth` is rejected on local servers. Each platform receives its own field spelling:

| Platform | Written form |
| --- | --- |
| `codex` | `[mcp_servers.<name>.oauth]` with `client_id` |
| `claude` | `"oauth": { "clientId": "..." }` |
| `agents` | `"oauth": { "clientId": "..." }` |

OAuth tokens are not part of the project configuration. Codex still requires a per-machine `codex mcp login <name>`, and Claude Code and Pi authenticate on their own. Codex also requires the project to be trusted before it reads project MCP configuration at all: the repository path must appear in `~/.codex/config.toml` as `[projects."<path>"]` with `trust_level = "trusted"`.

Base instruction `PATH` values and destination conflicts are checked before any changes are made. If a selected `PATH` does not point to a file, or multiple selected base instructions resolve to the same destination, the command exits without writing SKILL, MCP, or base instruction changes. Existing base instruction symlinks are replaced; existing regular files or directories are kept and reported as warnings. Destination comparisons follow the current filesystem's casing behavior.
