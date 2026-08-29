import { lstat, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import assert from "node:assert/strict";

import { ConfigError } from "../src/config.js";
import { linkBaseInstructions, linkMode, validateBaseInstructions } from "../src/linker.js";

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
      ["codex", "claude"],
    );

    assert.equal(result.created.length, 2);
    assert.equal(result.created[0]?.name, "valid-skill");
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? "", /directory does not exist/);
    assert.equal(
      await realpath(join(destination, ".codex", "skills", "valid-skill")),
      await realpath(source),
    );
    assert.equal(
      await realpath(join(destination, ".claude", "skills", "valid-skill")),
      await realpath(source),
    );
  });

  it("replaces an existing symlink", async () => {
    const root = await makeWorkspace();
    const source = await makeSkill(root, "skill-a");
    const oldTarget = await makeSkill(root, "old-target");
    const destination = join(root, "output");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(destination, ".codex", "skills"), { recursive: true });
    await symlink(oldTarget, join(destination, ".codex", "skills", "skill-a"), "dir");

    const result = await linkMode("dev", [source], root, destination, ["codex"]);

    assert.equal(result.created[0]?.replaced, true);
    assert.equal(
      await realpath(join(destination, ".codex", "skills", "skill-a")),
      await realpath(source),
    );
  });

  it("silently skips an existing file or directory", async () => {
    const root = await makeWorkspace();
    const source = await makeSkill(root, "skill-a");
    const destination = join(root, "output");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(destination);
    await mkdir(join(destination, ".codex", "skills"), { recursive: true });
    await writeFile(join(destination, ".codex", "skills", "skill-a"), "keep me\n");

    const result = await linkMode("dev", [source], root, destination, ["codex"]);

    assert.deepEqual(result.created, []);
    assert.deepEqual(result.warnings, []);
    assert.equal(
      await readFile(join(destination, ".codex", "skills", "skill-a"), "utf8"),
      "keep me\n",
    );
  });

  it("rejects duplicate link names within a mode", async () => {
    const root = await makeWorkspace();
    const first = await makeSkill(join(root, "one"), "same-name");
    const second = await makeSkill(join(root, "two"), "same-name");

    await assert.rejects(
      linkMode("dev", [first, second], root, join(root, "output"), ["codex"]),
      (error: unknown) => error instanceof ConfigError && /duplicate link name/.test(error.message),
    );
  });

  it("links base instruction files using platform destinations", async () => {
    const root = await makeWorkspace();
    const claudeInstruction = join(root, "CLAUDE.md");
    const agentsInstruction = join(root, "AGENTS.md");
    await writeFile(claudeInstruction, "claude\n");
    await writeFile(agentsInstruction, "agents\n");

    const result = await linkBaseInstructions(
      {
        claude: { PATH: claudeInstruction, NAME: "CLAUDE.md" },
        codex: { PATH: agentsInstruction, NAME: "AGENTS.md" },
        agents: { PATH: agentsInstruction, NAME: "opencode-AGENTS.md" },
      },
      root,
      join(root, "output"),
      ["codex", "claude", "agents"],
    );

    assert.deepEqual(result.warnings, []);
    assert.equal(result.created.length, 3);
    assert.equal(await realpath(join(root, "output", ".claude", "CLAUDE.md")), await realpath(claudeInstruction));
    assert.equal(await realpath(join(root, "output", "AGENTS.md")), await realpath(agentsInstruction));
    assert.equal(await realpath(join(root, "output", "opencode-AGENTS.md")), await realpath(agentsInstruction));
  });

  it("replaces base instruction symlinks but warns for regular files", async () => {
    const root = await makeWorkspace();
    const source = join(root, "instruction.md");
    const oldSource = join(root, "old.md");
    await writeFile(source, "new\n");
    await writeFile(oldSource, "old\n");
    const cwd = join(root, "output");
    await mkdir(join(cwd, ".claude"), { recursive: true });
    await symlink(oldSource, join(cwd, ".claude", "CLAUDE.md"), "file");
    await writeFile(join(cwd, "AGENTS.md"), "keep\n");

    const result = await linkBaseInstructions(
      {
        claude: { PATH: source, NAME: "CLAUDE.md" },
        codex: { PATH: source, NAME: "AGENTS.md" },
      },
      root,
      cwd,
      ["claude", "codex"],
    );

    assert.equal(result.created.length, 1);
    assert.equal(result.created[0]?.replaced, true);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? "", /destination exists and is not a symlink/);
    assert.equal(await realpath(join(cwd, ".claude", "CLAUDE.md")), await realpath(source));
    assert.equal(await readFile(join(cwd, "AGENTS.md"), "utf8"), "keep\n");
  });

  it("rejects missing paths and conflicting base instruction destinations before linking", async () => {
    const root = await makeWorkspace();
    const source = join(root, "instruction.md");
    await writeFile(source, "instruction\n");
    const cwd = join(root, "output");

    await assert.rejects(
      validateBaseInstructions(
        { claude: { PATH: join(root, "missing.md"), NAME: "CLAUDE.md" } },
        root,
        cwd,
        ["claude"],
      ),
      /PATH does not exist/,
    );

    await assert.rejects(
      validateBaseInstructions(
        {
          codex: { PATH: source, NAME: "AGENTS.md" },
          agents: { PATH: source, NAME: "AGENTS.md" },
        },
        root,
        cwd,
        ["codex", "agents"],
      ),
      /destinations conflict/,
    );

    assert.equal((await linkBaseInstructions({}, root, cwd, ["claude"])).created.length, 0);
    await assert.rejects(lstat(cwd), { code: "ENOENT" });
  });

  it("creates platform directories when every source is invalid", async () => {
    const root = await makeWorkspace();
    const destination = join(root, "output");
    const { mkdir, stat } = await import("node:fs/promises");
    await mkdir(destination);

    const result = await linkMode(
      "dev",
      [join(root, "missing-skill")],
      root,
      destination,
      ["codex", "claude", "agents"],
    );

    assert.equal(result.created.length, 0);
    assert.equal(result.warnings.length, 1);
    assert.equal((await stat(join(destination, ".codex", "skills"))).isDirectory(), true);
    assert.equal((await stat(join(destination, ".claude", "skills"))).isDirectory(), true);
    assert.equal((await stat(join(destination, ".agents", "skills"))).isDirectory(), true);
  });
});
