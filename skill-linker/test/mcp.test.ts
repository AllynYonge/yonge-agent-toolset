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

    const agents = JSON.parse(await readFile(join(root, ".pi", "mcp.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(agents, {
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
  });

  it("maps startup_timeout_sec per platform and validates positive integers", async () => {
    const root = await makeWorkspace();

    const result = await writeMcpServers(
      {
        slow: {
          type: "local",
          command: "npx",
          args: ["-y", "mcp-remote", "https://example.com/sse"],
          startup_timeout_sec: 120,
        },
        remoteSlow: {
          type: "remote",
          url: "https://example.com/mcp",
          startup_timeout_sec: 30,
        },
      },
      root,
      ["codex", "claude", "agents"],
    );

    assert.equal(result.warnings.length, 0);

    const codex = parseToml(
      await readFile(join(root, ".codex", "config.toml"), "utf8"),
    ) as { mcp_servers: Record<string, { startup_timeout_sec?: number }> };
    assert.equal(codex.mcp_servers.slow?.startup_timeout_sec, 120);
    assert.equal(codex.mcp_servers.remoteSlow?.startup_timeout_sec, 30);

    const claude = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    assert.equal("timeout" in claude.mcpServers.slow!, false);
    assert.equal("startup_timeout_sec" in claude.mcpServers.slow!, false);
    assert.equal("timeout" in claude.mcpServers.remoteSlow!, false);

    const agents = JSON.parse(await readFile(join(root, ".pi", "mcp.json"), "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    assert.equal("timeout" in agents.mcpServers.slow!, false);
    assert.equal("startup_timeout_sec" in agents.mcpServers.slow!, false);
    assert.equal("timeout" in agents.mcpServers.remoteSlow!, false);

    const invalid = await writeMcpServers(
      {
        zero: { type: "remote", url: "https://example.com", startup_timeout_sec: 0 },
        decimal: { type: "remote", url: "https://example.com", startup_timeout_sec: 1.5 },
        string: { type: "remote", url: "https://example.com", startup_timeout_sec: "120" },
      },
      root,
      ["codex"],
    );

    assert.equal(invalid.written.length, 0);
    assert.equal(invalid.warnings.length, 3);
    assert.match(invalid.warnings[0] ?? "", /startup_timeout_sec must be a positive integer/);
  });

  it("maps oauth clientId per platform and validates it", async () => {
    const root = await makeWorkspace();

    const result = await writeMcpServers(
      {
        scys: {
          type: "remote",
          url: "https://mcp.scys.com/shengcai-web/mcp",
          oauth: { clientId: "scys-claude-code" },
        },
      },
      root,
      ["codex", "claude", "agents"],
    );

    assert.equal(result.warnings.length, 0);
    assert.equal(result.written.length, 3);

    const codex = parseToml(await readFile(join(root, ".codex", "config.toml"), "utf8")) as {
      mcp_servers: Record<string, { oauth?: { client_id?: string } }>;
    };
    assert.equal(codex.mcp_servers.scys?.oauth?.client_id, "scys-claude-code");

    const claude = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, { oauth?: { clientId?: string } }>;
    };
    assert.deepEqual(claude.mcpServers.scys?.oauth, { clientId: "scys-claude-code" });

    const agents = JSON.parse(await readFile(join(root, ".pi", "mcp.json"), "utf8")) as {
      mcpServers: Record<string, { oauth?: { clientId?: string } }>;
    };
    assert.deepEqual(agents.mcpServers.scys?.oauth, { clientId: "scys-claude-code" });
  });

  it("warns on invalid oauth and omits it from servers without oauth", async () => {
    const root = await makeWorkspace();

    const result = await writeMcpServers(
      {
        notAnObject: { type: "remote", url: "https://example.com", oauth: "client" },
        missingClientId: { type: "remote", url: "https://example.com", oauth: {} },
        emptyClientId: { type: "remote", url: "https://example.com", oauth: { clientId: "  " } },
        unknownField: {
          type: "remote",
          url: "https://example.com",
          oauth: { clientId: "a", client_id: "b" },
        },
        onLocal: { type: "local", command: "npx", oauth: { clientId: "a" } },
        plain: { type: "remote", url: "https://example.com" },
      },
      root,
      ["claude"],
    );

    assert.equal(result.warnings.length, 5);
    assert.match(result.warnings[0] ?? "", /oauth must be an object/);
    assert.match(result.warnings[1] ?? "", /non-empty "clientId"/);
    assert.match(result.warnings[2] ?? "", /non-empty "clientId"/);
    assert.match(result.warnings[3] ?? "", /oauth contains unknown field "client_id"/);
    assert.match(result.warnings[4] ?? "", /oauth is only supported for remote servers/);

    const claude = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    assert.deepEqual(Object.keys(claude.mcpServers), ["plain"]);
    assert.equal("oauth" in claude.mcpServers.plain!, false);
  });

  it("writes description only to the agents platform", async () => {
    const root = await makeWorkspace();

    const result = await writeMcpServers(
      {
        rea: {
          type: "local",
          command: "rea",
          args: ["--mcp"],
          description: "REA 逆向工程",
        },
        docs: {
          type: "remote",
          url: "https://example.com/mcp",
          description: "Product documentation",
        },
        plain: { type: "remote", url: "https://example.com/plain" },
      },
      root,
      ["codex", "claude", "agents"],
    );

    assert.deepEqual(result.warnings, []);

    const codex = parseToml(await readFile(join(root, ".codex", "config.toml"), "utf8")) as {
      mcp_servers: Record<string, Record<string, unknown>>;
    };
    assert.equal("description" in codex.mcp_servers.rea!, false);
    assert.equal("description" in codex.mcp_servers.docs!, false);

    const claude = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    assert.equal("description" in claude.mcpServers.rea!, false);
    assert.equal("description" in claude.mcpServers.docs!, false);

    const agents = JSON.parse(await readFile(join(root, ".pi", "mcp.json"), "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    assert.equal(agents.mcpServers.rea?.description, "REA 逆向工程");
    assert.equal(agents.mcpServers.docs?.description, "Product documentation");
    assert.equal("description" in agents.mcpServers.plain!, false);
  });

  it("rejects an empty or non-string description", async () => {
    const root = await makeWorkspace();

    const result = await writeMcpServers(
      {
        empty: { type: "local", command: "npx", description: "   " },
        notAString: { type: "remote", url: "https://example.com", description: 3 },
      },
      root,
      ["agents"],
    );

    assert.equal(result.written.length, 0);
    assert.equal(result.warnings.length, 2);
    assert.match(result.warnings[0] ?? "", /description must be a non-empty string/);
    assert.match(result.warnings[1] ?? "", /description must be a non-empty string/);
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
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(
      join(root, ".pi", "mcp.json"),
      JSON.stringify({ other: "pi", mcpServers: { keep: { type: "http", url: "keep" } } }),
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

    const agents = JSON.parse(await readFile(join(root, ".pi", "mcp.json"), "utf8")) as {
      other: string;
      mcpServers: Record<string, unknown>;
    };
    assert.equal(agents.other, "pi");
    assert.deepEqual(Object.keys(agents.mcpServers), ["keep", "filesystem"]);
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
    await assert.rejects(readFile(join(root, ".pi", "mcp.json")), { code: "ENOENT" });
  });
});
