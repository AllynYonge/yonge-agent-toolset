import { mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import assert from "node:assert/strict";

import { ConfigError } from "../src/config.js";
import { linkMode } from "../src/linker.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function makeWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "skill-linker-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function makeSkill(root: string, name: string): Promise<string> {
  const directory = join(root, name);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), `# ${name}\n`);
  return directory;
}

describe("linkMode", () => {
  it("links valid skills and warns about invalid sources", async () => {
    const root = await makeWorkspace();
    const source = await makeSkill(root, "valid-skill");
    const destination = join(root, "output");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(destination);
    const result = await linkMode(
      "dev",
      [source, join(root, "missing-skill")],
      root,
      destination,
    );

    assert.equal(result.created.length, 1);
    assert.equal(result.created[0]?.name, "valid-skill");
    assert.match(result.warnings[0] ?? "", /directory does not exist/);
    assert.equal(await realpath(join(destination, "valid-skill")), await realpath(source));
  });

  it("replaces an existing symlink", async () => {
    const root = await makeWorkspace();
    const source = await makeSkill(root, "skill-a");
    const oldTarget = await makeSkill(root, "old-target");
    const destination = join(root, "output");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(destination);
    await symlink(oldTarget, join(destination, "skill-a"), "dir");

    const result = await linkMode("dev", [source], root, destination);

    assert.equal(result.created[0]?.replaced, true);
    assert.equal(await realpath(join(destination, "skill-a")), await realpath(source));
  });

  it("silently skips an existing file or directory", async () => {
    const root = await makeWorkspace();
    const source = await makeSkill(root, "skill-a");
    const destination = join(root, "output");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(destination);
    await writeFile(join(destination, "skill-a"), "keep me\n");

    const result = await linkMode("dev", [source], root, destination);

    assert.deepEqual(result.created, []);
    assert.deepEqual(result.warnings, []);
    assert.equal(await readFile(join(destination, "skill-a"), "utf8"), "keep me\n");
  });

  it("rejects duplicate link names within a mode", async () => {
    const root = await makeWorkspace();
    const first = await makeSkill(join(root, "one"), "same-name");
    const second = await makeSkill(join(root, "two"), "same-name");

    await assert.rejects(
      linkMode("dev", [first, second], root, join(root, "output")),
      (error: unknown) => error instanceof ConfigError && /duplicate link name/.test(error.message),
    );
  });
});
