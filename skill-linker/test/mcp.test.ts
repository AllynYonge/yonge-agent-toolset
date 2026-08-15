import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { parse as parseToml } from "smol-toml";

import { writeMcpServers } from "../src/mcp.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "skill-linker-mcp-test-"));
  temporaryDirectories.push(root);
  return root;
}

const servers = {
  filesystem: {
    type: "local",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
    env: { API_KEY: "{env:API_KEY}" },
  },
  context7: {
    type: "remote",
    url: "https://mcp.context7.com/mcp",
    headers: { Authorization: "Bearer {env:CONTEXT7_TOKEN}" },
  },
};

describe("MCP configuration writing", () => {
  it("converts local and remote servers for all platforms", async () => {
    const root = await makeWorkspace();

    const result = await writeMcpServers(servers, root, ["codex", "claude", "agents"]);

    assert.equal(result.written.length, 6);
    assert.deepEqual(result.warnings, []);

    const codex = parseToml(await readFile(join(root, ".codex", "config.toml"), "utf8"));
    assert.deepEqual(codex, {
      mcp_servers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
          env: { API_KEY: "{env:API_KEY}" },
        },
        context7: {
          url: "https://mcp.context7.com/mcp",
          http_headers: { Authorization: "Bearer {env:CONTEXT7_TOKEN}" },
        },
      },
    });

    const claude = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(claude, {
      mcpServers: {
        filesystem: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
          env: { API_KEY: "{env:API_KEY}" },
        },
        context7: {
          type: "http",
          url: "https://mcp.context7.com/mcp",
          headers: { Authorization: "Bearer {env:CONTEXT7_TOKEN}" },
        },
      },
    });

    const openCode = JSON.parse(await readFile(join(root, "opencode.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(openCode, {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        filesystem: {
          type: "local",
          command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."],
          environment: { API_KEY: "{env:API_KEY}" },
        },
        context7: {
          type: "remote",
          url: "https://mcp.context7.com/mcp",
          headers: { Authorization: "Bearer {env:CONTEXT7_TOKEN}" },
        },
      },
    });
  });

  it("merges existing configs and preserves unrelated Codex text", async () => {
    const root = await makeWorkspace();
    await mkdir(join(root, ".codex"), { recursive: true });
    await writeFile(
      join(root, ".codex", "config.toml"),
      [
        "# keep this comment",
        'model = "gpt-test"',
        "",
        "[mcp_servers.keep]",
        'command = "keep-command"',
        "",
        "[mcp_servers.filesystem]",
        'command = "old-command"',
        "",
      ].join("\n"),
    );
    await writeFile(
      join(root, ".mcp.json"),
      JSON.stringify({ other: true, mcpServers: { keep: { command: "keep" } } }),
    );
    await writeFile(
      join(root, "opencode.json"),
      JSON.stringify({ model: "test", mcp: { servers: { keep: { type: "remote", url: "keep" } } } }),
    );

    await writeMcpServers({ filesystem: servers.filesystem }, root, ["codex", "claude", "agents"]);

    const codexRaw = await readFile(join(root, ".codex", "config.toml"), "utf8");
    assert.match(codexRaw, /^# keep this comment\nmodel = "gpt-test"\n/);
    assert.match(codexRaw, /# keep this comment/);
    assert.match(codexRaw, /command = "keep-command"/);
    assert.doesNotMatch(codexRaw, /old-command/);
    assert.match(codexRaw, /@modelcontextprotocol\/server-filesystem/);

    const claude = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")) as {
      other: boolean;
      mcpServers: Record<string, unknown>;
    };
    assert.equal(claude.other, true);
    assert.deepEqual(Object.keys(claude.mcpServers), ["keep", "filesystem"]);

    const openCode = JSON.parse(await readFile(join(root, "opencode.json"), "utf8")) as {
      model: string;
      mcp: { servers: Record<string, unknown> };
    };
    assert.equal(openCode.model, "test");
    assert.deepEqual(Object.keys(openCode.mcp.servers), ["keep", "filesystem"]);
  });

  it("warns once per invalid service and still writes valid services", async () => {
    const root = await makeWorkspace();
    const result = await writeMcpServers(
      {
        "invalid name": { type: "remote", url: "https://example.com" },
        missing_command: { type: "local" },
        context7: servers.context7,
      },
      root,
      ["codex", "claude", "agents"],
    );

    assert.equal(result.warnings.length, 2);
    assert.equal(result.written.length, 3);
    assert.match(result.warnings[0] ?? "", /invalid name/);
    assert.match(result.warnings[1] ?? "", /missing_command/);
  });

  it("preserves an invalid target config and skips only that platform", async () => {
    const root = await makeWorkspace();
    await writeFile(join(root, ".mcp.json"), "{ invalid json\n");

    const result = await writeMcpServers({ context7: servers.context7 }, root, ["claude"]);

    assert.equal(result.written.length, 0);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? "", /cannot parse/);
    assert.equal(await readFile(join(root, ".mcp.json"), "utf8"), "{ invalid json\n");
  });

  it("does not create configuration files when no MCP servers are configured", async () => {
    const root = await makeWorkspace();
    const result = await writeMcpServers({}, root, ["codex", "claude", "agents"]);

    assert.deepEqual(result, { written: [], warnings: [] });
    await assert.rejects(readFile(join(root, ".codex", "config.toml")), { code: "ENOENT" });
    await assert.rejects(readFile(join(root, ".mcp.json")), { code: "ENOENT" });
    await assert.rejects(readFile(join(root, "opencode.json")), { code: "ENOENT" });
  });
});
