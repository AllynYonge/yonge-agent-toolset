# @yonge/skill-linker

Link groups of SKILL directories into the current working directory.

## Usage

By default, the CLI first looks for `~/.yonge-skill/skill-linker.config.json`, then falls back to `skill-linker.config.json` in the current working directory. Create either file with this structure:

```json
{
  "modes": {
    "dev": [
      "/path/to/skills/browser",
      "../skills/documents"
    ]
  }
}
```

Each source directory must contain `SKILL.md`. Relative source paths are resolved relative to the configuration file.

```bash
npx @yonge/skill-linker list
npx @yonge/skill-linker link dev
npx @yonge/skill-linker link dev --config /path/to/skill-linker.config.json
```

The `--config` option overrides the default search for that command only.

Links are created in the current working directory. Existing symlinks with the same name are replaced. Existing files and directories are left untouched and skipped silently. Invalid source paths are skipped with a warning on stderr.
