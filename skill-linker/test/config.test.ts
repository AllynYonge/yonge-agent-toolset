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
    const configPath = join(root, "config", "skill-linker.config.json");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(configPath, JSON.stringify({ modes: { dev: ["../skills/a"] } }));

    const loaded = await loadConfig(configPath, "/different/current/directory");

    assert.equal(loaded.config.modes.dev?.[0], "../skills/a");
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
      join(home, ".yonge-skill", "skill-linker.config.json"),
      JSON.stringify({ modes: { home: [] } }),
    );
    await writeFile(
      join(cwd, "skill-linker.config.json"),
      JSON.stringify({ modes: { local: [] } }),
    );

    const loaded = await loadConfig(undefined, cwd, home);

    assert.deepEqual(Object.keys(loaded.config.modes), ["home"]);
    assert.deepEqual(resolveConfigPaths(undefined, cwd, home), [
      join(home, ".yonge-skill", "skill-linker.config.json"),
      join(cwd, "skill-linker.config.json"),
    ]);
  });

  it("rejects malformed mode entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-linker-config-test-"));
    temporaryDirectories.push(root);
    const configPath = join(root, "skill-linker.config.json");
    await writeFile(configPath, JSON.stringify({ modes: { dev: "not-an-array" } }));

    await assert.rejects(loadConfig(configPath), /must be an array of source paths/);
  });
});
