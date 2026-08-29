import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import assert from "node:assert/strict";

import { loadConfig, resolveConfigPaths, resolveSourcePath } from "../src/config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("configuration", () => {
  it("resolves relative sources from the configuration directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-linker-config-test-"));
    temporaryDirectories.push(root);
    const configPath = join(root, "config", "linker.config.json");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({ modes: { dev: { skills: ["../skills/a"] } } }),
    );

    const loaded = await loadConfig(configPath, "/different/current/directory");

    assert.equal(loaded.config.modes.dev?.skills[0], "../skills/a");
    assert.equal(resolveSourcePath("../skills/a", loaded.configDirectory), join(root, "skills", "a"));
  });

  it("prefers the home configuration before the current directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-linker-config-test-"));
    const home = join(root, "home");
    const cwd = join(root, "workspace");
    temporaryDirectories.push(root);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, ".yonge-skill"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(
      join(home, ".yonge-skill", "linker.config.json"),
      JSON.stringify({ modes: { home: { skills: [] } } }),
    );
    await writeFile(
      join(cwd, "linker.config.json"),
      JSON.stringify({ modes: { local: { skills: [] } } }),
    );

    const loaded = await loadConfig(undefined, cwd, home);

    assert.deepEqual(Object.keys(loaded.config.modes), ["home"]);
    assert.deepEqual(resolveConfigPaths(undefined, cwd, home), [
      join(home, ".yonge-skill", "linker.config.jsonc"),
      join(home, ".yonge-skill", "linker.config.json"),
      join(cwd, "linker.config.jsonc"),
      join(cwd, "linker.config.json"),
    ]);
  });

  it("parses JSONC comments and trailing commas", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-linker-config-test-"));
    temporaryDirectories.push(root);
    const configPath = join(root, "linker.config.jsonc");
    await writeFile(
      configPath,
      [
        "{",
        "  // 中文模式注释",
        '  "modes": {',
        '    "dev": {',
        '      "skills": ["../skills/a",],',
        "    },",
        "  },",
        "}",
      ].join("\n"),
    );

    const loaded = await loadConfig(configPath);

    assert.deepEqual(loaded.config.modes.dev?.skills, ["../skills/a"]);
  });

  it("rejects malformed mode entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-linker-config-test-"));
    temporaryDirectories.push(root);
    const configPath = join(root, "linker.config.json");
    await writeFile(configPath, JSON.stringify({ modes: { dev: ["old-format"] } }));

    await assert.rejects(loadConfig(configPath), /must be an object/);
  });

  it("loads baseInstruction modes and applies strict field validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-linker-config-test-"));
    temporaryDirectories.push(root);
    const configPath = join(root, "linker.config.json");

    await writeFile(
      configPath,
      JSON.stringify({
        modes: {
          instructions: {
            baseInstruction: {
              claude: { PATH: "../CLAUDE.md", NAME: "CLAUDE.md" },
            },
          },
          empty: { baseInstruction: {} },
        },
      }),
    );

    const loaded = await loadConfig(configPath);
    assert.deepEqual(loaded.config.modes.instructions?.baseInstruction, {
      claude: { PATH: "../CLAUDE.md", NAME: "CLAUDE.md" },
    });
    assert.deepEqual(loaded.config.modes.empty?.baseInstruction, {});

    const invalidCases: Array<[string, Record<string, unknown>]> = [
      ["unknown platform", { baseInstruction: { cursor: { PATH: "a", NAME: "b" } } }],
      ["unknown field", { baseInstruction: { claude: { PATH: "a", name: "b" } } }],
      ["missing name", { baseInstruction: { claude: { PATH: "a" } } }],
      ["invalid name", { baseInstruction: { claude: { PATH: "a", NAME: "../b" } } }],
      ["invalid object", { baseInstruction: [] }],
    ];

    for (const [label, mode] of invalidCases) {
      await writeFile(configPath, JSON.stringify({ modes: { dev: mode } }));
      await assert.rejects(
        loadConfig(configPath),
        (error: unknown) => error instanceof Error && /baseInstruction|NAME/.test(error.message),
        label,
      );
    }

    await writeFile(configPath, JSON.stringify({ modes: { empty: {} } }));
    await assert.rejects(
      loadConfig(configPath),
      /must contain "skills", "mcpServers", or "baseInstruction"/,
    );
  });

  it("loads MCP-only modes and rejects empty mode objects", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-linker-config-test-"));
    temporaryDirectories.push(root);
    const configPath = join(root, "linker.config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        modes: {
          research: {
            mcpServers: {
              context7: { type: "remote", url: "https://mcp.context7.com/mcp" },
            },
          },
        },
      }),
    );

    const loaded = await loadConfig(configPath);
    assert.deepEqual(loaded.config.modes.research?.skills, []);
    assert.deepEqual(Object.keys(loaded.config.modes.research?.mcpServers ?? {}), ["context7"]);

    await writeFile(configPath, JSON.stringify({ modes: { empty: {} } }));
    await assert.rejects(loadConfig(configPath), /must contain "skills", "mcpServers", or "baseInstruction"/);
  });
});
