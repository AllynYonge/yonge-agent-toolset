import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, it } from "node:test";

import { run } from "../src/cli.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

class CaptureStream extends Writable {
  readonly chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString() : chunk);
    callback();
  }

  text(): string {
    return this.chunks.join("");
  }
}

async function makeFixture(): Promise<{
  root: string;
  cwd: string;
  source: string;
  configPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "skill-linker-cli-test-"));
  temporaryDirectories.push(root);
  const cwd = join(root, "workspace");
  const source = join(root, "browser");
  const configPath = join(root, "linker.config.json");
  await mkdir(cwd);
  await mkdir(source);
  await writeFile(join(source, "SKILL.md"), "# browser\n");
  await writeFile(configPath, JSON.stringify({ modes: { dev: { skills: [source] } } }));
  return { root, cwd, source, configPath };
}

describe("CLI platform handling", () => {
  it("lists both SKILL and MCP counts", async () => {
    const fixture = await makeFixture();
    await writeFile(
      fixture.configPath,
      JSON.stringify({
        modes: {
          dev: {
            skills: [fixture.source],
            mcpServers: {
              context7: { type: "remote", url: "https://mcp.context7.com/mcp" },
            },
          },
        },
      }),
    );
    const stdout = new CaptureStream();

    const exitCode = await run(
      ["list", "--config", fixture.configPath],
      fixture.cwd,
      stdout,
      new CaptureStream(),
    );

    assert.equal(exitCode, 0);
    assert.equal(stdout.text(), "dev  1 skill  1 MCP\n");
  });

  it("links all platforms when --platform is omitted", async () => {
    const fixture = await makeFixture();
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    const exitCode = await run(
      ["link", "dev", "--config", fixture.configPath],
      fixture.cwd,
      stdout,
      stderr,
    );

    assert.equal(exitCode, 0);
    assert.equal(stderr.text(), "");
    assert.equal(
      await realpath(join(fixture.cwd, ".codex", "skills", "browser")),
      await realpath(fixture.source),
    );
    assert.equal(
      await realpath(join(fixture.cwd, ".claude", "skills", "browser")),
      await realpath(fixture.source),
    );
    assert.equal(
      await realpath(join(fixture.cwd, ".agents", "skills", "browser")),
      await realpath(fixture.source),
    );
    assert.match(stdout.text(), /LINK: \.codex\/skills\/browser/);
    assert.match(stdout.text(), /LINK: \.claude\/skills\/browser/);
    assert.match(stdout.text(), /LINK: \.agents\/skills\/browser/);
  });

  it("links only the selected platform", async () => {
    const fixture = await makeFixture();
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    const exitCode = await run(
      ["link", "dev", "--platform", "codex", "--config", fixture.configPath],
      fixture.cwd,
      stdout,
      stderr,
    );

    assert.equal(exitCode, 0);
    assert.equal(stderr.text(), "");
    assert.equal(
      await realpath(join(fixture.cwd, ".codex", "skills", "browser")),
      await realpath(fixture.source),
    );
    await assert.rejects(lstat(join(fixture.cwd, ".claude")), { code: "ENOENT" });
    await assert.rejects(lstat(join(fixture.cwd, ".agents")), { code: "ENOENT" });
  });

  it("merges multiple modes from left to right before validation", async () => {
    const fixture = await makeFixture();
    const devBrowser = join(fixture.root, "dev", "browser");
    const researchBrowser = join(fixture.root, "research", "browser");
    const sharedSkill = join(fixture.root, "shared-skill");
    await mkdir(devBrowser, { recursive: true });
    await mkdir(researchBrowser, { recursive: true });
    await mkdir(sharedSkill, { recursive: true });
    await writeFile(join(devBrowser, "SKILL.md"), "# dev browser\n");
    await writeFile(join(researchBrowser, "SKILL.md"), "# research browser\n");
    await writeFile(join(sharedSkill, "SKILL.md"), "# shared skill\n");
    await writeFile(
      fixture.configPath,
      JSON.stringify({
        modes: {
          dev: {
            skills: [devBrowser, sharedSkill],
            mcpServers: { context7: { type: "local" } },
          },
          research: {
            skills: [researchBrowser, sharedSkill],
            mcpServers: {
              context7: { type: "remote", url: "https://mcp.context7.com/mcp" },
            },
          },
        },
      }),
    );
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    const exitCode = await run(
      ["link", "dev", "research", "--platform", "codex", "--config", fixture.configPath],
      fixture.cwd,
      stdout,
      stderr,
    );

    assert.equal(exitCode, 0);
    assert.equal(stderr.text(), "");
    assert.equal(
      await realpath(join(fixture.cwd, ".codex", "skills", "browser")),
      await realpath(researchBrowser),
    );
    assert.equal(
      await realpath(join(fixture.cwd, ".codex", "skills", "shared-skill")),
      await realpath(sharedSkill),
    );
    assert.equal((stdout.text().match(/LINK:/g) ?? []).length, 2);
    assert.equal((stdout.text().match(/MCP: context7/g) ?? []).length, 1);
    assert.match(
      await readFile(join(fixture.cwd, ".codex", "config.toml"), "utf8"),
      /url = "https:\/\/mcp\.context7\.com\/mcp"/,
    );
  });

  it("lists baseInstruction counts", async () => {
    const fixture = await makeFixture();
    await writeFile(
      fixture.configPath,
      JSON.stringify({
        modes: {
          dev: {
            baseInstruction: {
              claude: { PATH: fixture.root, NAME: "CLAUDE.md" },
              codex: { PATH: fixture.root, NAME: "AGENTS.md" },
            },
          },
        },
      }),
    );
    const stdout = new CaptureStream();

    const exitCode = await run(
      ["list", "--config", fixture.configPath],
      fixture.cwd,
      stdout,
      new CaptureStream(),
    );

    assert.equal(exitCode, 0);
    assert.equal(stdout.text(), "dev  0 skills  0 MCPs  2 baseInstructions\n");
  });

  it("links base instructions for the selected platform", async () => {
    const fixture = await makeFixture();
    const claudeInstruction = join(fixture.root, "CLAUDE.md");
    await writeFile(claudeInstruction, "claude instruction\n");
    await writeFile(
      fixture.configPath,
      JSON.stringify({
        modes: {
          dev: {
            skills: [fixture.source],
            baseInstruction: {
              claude: { PATH: claudeInstruction, NAME: "CLAUDE.md" },
            },
          },
        },
      }),
    );
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    const exitCode = await run(
      ["link", "dev", "--platform", "claude", "--config", fixture.configPath],
      fixture.cwd,
      stdout,
      stderr,
    );

    assert.equal(exitCode, 0);
    assert.equal(stderr.text(), "");
    assert.match(stdout.text(), /BASE: \.claude\/CLAUDE\.md -> .*CLAUDE\.md/);
    assert.equal(
      await realpath(join(fixture.cwd, ".claude", "CLAUDE.md")),
      await realpath(claudeInstruction),
    );
  });

  it("merges base instructions by platform from left to right", async () => {
    const fixture = await makeFixture();
    const firstInstruction = join(fixture.root, "first.md");
    const secondInstruction = join(fixture.root, "second.md");
    await writeFile(firstInstruction, "first\n");
    await writeFile(secondInstruction, "second\n");
    await writeFile(
      fixture.configPath,
      JSON.stringify({
        modes: {
          first: {
            baseInstruction: {
              claude: { PATH: firstInstruction, NAME: "CLAUDE.md" },
            },
          },
          second: {
            baseInstruction: {
              claude: { PATH: secondInstruction, NAME: "CLAUDE.md" },
            },
          },
        },
      }),
    );

    const exitCode = await run(
      ["link", "first", "second", "--platform", "claude", "--config", fixture.configPath],
      fixture.cwd,
      new CaptureStream(),
      new CaptureStream(),
    );

    assert.equal(exitCode, 0);
    assert.equal(
      await realpath(join(fixture.cwd, ".claude", "CLAUDE.md")),
      await realpath(secondInstruction),
    );
  });

  it("makes no changes when a base instruction fails preflight", async () => {
    const fixture = await makeFixture();
    const instruction = join(fixture.root, "CLAUDE.md");
    await writeFile(instruction, "instruction\n");
    await writeFile(
      fixture.configPath,
      JSON.stringify({
        modes: {
          dev: {
            skills: [fixture.source],
            mcpServers: { context7: { type: "remote", url: "https://mcp.context7.com/mcp" } },
            baseInstruction: {
              claude: { PATH: join(fixture.root, "missing.md"), NAME: "CLAUDE.md" },
            },
          },
        },
      }),
    );
    const stderr = new CaptureStream();

    const exitCode = await run(
      ["link", "dev", "--config", fixture.configPath],
      fixture.cwd,
      new CaptureStream(),
      stderr,
    );

    assert.equal(exitCode, 1);
    assert.match(stderr.text(), /PATH does not exist/);
    await assert.rejects(lstat(join(fixture.cwd, ".claude")), { code: "ENOENT" });
    await assert.rejects(lstat(join(fixture.cwd, ".codex")), { code: "ENOENT" });
    await assert.rejects(lstat(join(fixture.cwd, ".mcp.json")), { code: "ENOENT" });
  });

  it("warns when a base instruction destination is a regular file", async () => {
    const fixture = await makeFixture();
    const instruction = join(fixture.root, "CLAUDE.md");
    await writeFile(instruction, "instruction\n");
    await mkdir(join(fixture.cwd, ".claude"), { recursive: true });
    await writeFile(join(fixture.cwd, ".claude", "CLAUDE.md"), "keep\n");
    await writeFile(
      fixture.configPath,
      JSON.stringify({
        modes: {
          dev: {
            baseInstruction: { claude: { PATH: instruction, NAME: "CLAUDE.md" } },
          },
        },
      }),
    );
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    const exitCode = await run(
      ["link", "dev", "--platform", "claude", "--config", fixture.configPath],
      fixture.cwd,
      stdout,
      stderr,
    );

    assert.equal(exitCode, 0);
    assert.equal(stdout.text(), "");
    assert.match(stderr.text(), /WARN: skipped BASE CLAUDE\.md/);
    assert.equal(await readFile(join(fixture.cwd, ".claude", "CLAUDE.md"), "utf8"), "keep\n");
  });

  it("does not make changes when any requested mode is unknown", async () => {
    const fixture = await makeFixture();
    const stderr = new CaptureStream();

    const exitCode = await run(
      ["link", "dev", "missing", "--platform", "codex", "--config", fixture.configPath],
      fixture.cwd,
      new CaptureStream(),
      stderr,
    );

    assert.equal(exitCode, 1);
    assert.match(stderr.text(), /unknown mode: missing/);
    await assert.rejects(lstat(join(fixture.cwd, ".codex")), { code: "ENOENT" });
  });

  it("writes MCP configuration only for the selected platform", async () => {
    const fixture = await makeFixture();
    await writeFile(
      fixture.configPath,
      JSON.stringify({
        modes: {
          mcp: {
            mcpServers: {
              context7: { type: "remote", url: "https://mcp.context7.com/mcp" },
            },
          },
        },
      }),
    );
    const stdout = new CaptureStream();

    const exitCode = await run(
      ["link", "mcp", "--platform", "agents", "--config", fixture.configPath],
      fixture.cwd,
      stdout,
      new CaptureStream(),
    );

    assert.equal(exitCode, 0);
    assert.match(stdout.text(), /MCP: context7 -> \.pi\/mcp\.json/);
    const agents = JSON.parse(await readFile(join(fixture.cwd, ".pi", "mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(agents.mcpServers), ["context7"]);
    await assert.rejects(lstat(join(fixture.cwd, ".mcp.json")), { code: "ENOENT" });
    await assert.rejects(lstat(join(fixture.cwd, ".codex")), { code: "ENOENT" });
  });

  it("continues linking SKILLs when the platform MCP config is invalid", async () => {
    const fixture = await makeFixture();
    await writeFile(
      fixture.configPath,
      JSON.stringify({
        modes: {
          dev: {
            skills: [fixture.source],
            mcpServers: {
              context7: { type: "remote", url: "https://mcp.context7.com/mcp" },
            },
          },
        },
      }),
    );
    await writeFile(join(fixture.cwd, ".mcp.json"), "{ invalid json\n");
    const stderr = new CaptureStream();

    const exitCode = await run(
      ["link", "dev", "--platform", "claude", "--config", fixture.configPath],
      fixture.cwd,
      new CaptureStream(),
      stderr,
    );

    assert.equal(exitCode, 0);
    assert.match(stderr.text(), /WARN: skipped MCP config \.mcp\.json/);
    assert.equal(
      await realpath(join(fixture.cwd, ".claude", "skills", "browser")),
      await realpath(fixture.source),
    );
    assert.equal(await readFile(join(fixture.cwd, ".mcp.json"), "utf8"), "{ invalid json\n");
  });

  it("rejects --platform for list and repeated platform arguments", async () => {
    const fixture = await makeFixture();
    const listError = new CaptureStream();
    const repeatedError = new CaptureStream();

    assert.equal(
      await run(
        ["list", "--platform", "codex", "--config", fixture.configPath],
        fixture.cwd,
        new CaptureStream(),
        listError,
      ),
      1,
    );
    assert.match(listError.text(), /list does not accept --platform/);

    assert.equal(
      await run(
        [
          "link",
          "dev",
          "--platform",
          "codex",
          "--platform",
          "claude",
          "--config",
          fixture.configPath,
        ],
        fixture.cwd,
        new CaptureStream(),
        repeatedError,
      ),
      1,
    );
    assert.match(repeatedError.text(), /at most one --platform/);
  });

  it("rejects platform values that are not strict lowercase names", async () => {
    const fixture = await makeFixture();
    const stderr = new CaptureStream();

    const exitCode = await run(
      ["link", "dev", "--platform", "Codex", "--config", fixture.configPath],
      fixture.cwd,
      new CaptureStream(),
      stderr,
    );

    assert.equal(exitCode, 1);
    assert.match(stderr.text(), /invalid platform "Codex"/);
  });

  it("warns and skips a platform whose directory path is blocked", async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.cwd, ".codex"), "blocked\n");
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    const exitCode = await run(
      ["link", "dev", "--config", fixture.configPath],
      fixture.cwd,
      stdout,
      stderr,
    );

    assert.equal(exitCode, 0);
    assert.match(stderr.text(), /WARN: skipped platform codex/);
    assert.equal(
      await realpath(join(fixture.cwd, ".claude", "skills", "browser")),
      await realpath(fixture.source),
    );
    assert.equal(
      await realpath(join(fixture.cwd, ".agents", "skills", "browser")),
      await realpath(fixture.source),
    );
  });
});
