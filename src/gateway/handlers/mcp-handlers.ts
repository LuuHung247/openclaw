/**
 * MCP REST API handlers — GET/POST/DELETE /api/mcp/servers
 *
 * GET  /api/mcp/servers          → list configured + connection status
 * POST /api/mcp/servers          → add a server to config + connect
 * DELETE /api/mcp/servers/:name  → remove from config + disconnect
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getMcpManager, resetMcpManager } from "../../agents/mcp-manager.js";
import type { ClawdisConfig, McpServerConfig } from "../../config/config.js";
import { writeConfigFile } from "../../config/config.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function jsonResponse(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── GET /api/mcp/servers ─────────────────────────────────────────────────────

export function handleMcpList(
  res: ServerResponse,
  config: ClawdisConfig,
): void {
  const configured = config.mcp_servers ?? [];
  const manager = getMcpManager();
  const statuses = manager.serverStatuses(configured);

  const connected = statuses.filter((s) => s.connected);
  // configured = all servers with their config merged in (for the UI to show transport info)
  const configuredWithStatus = configured.map((cfg) => {
    const status = statuses.find((s) => s.name === cfg.name);
    return {
      ...cfg,
      connected: status?.connected ?? false,
      error: status?.error,
    };
  });

  jsonResponse(res, 200, {
    connected: connected.map((s) => ({
      name: s.name,
      connected: true,
      tools_count: s.tools.length,
      tools: s.tools,
    })),
    configured: configuredWithStatus,
    total_configured: configured.length,
    total_connected: connected.length,
  });
}

// ─── POST /api/mcp/servers ────────────────────────────────────────────────────

export async function handleMcpAdd(
  req: IncomingMessage,
  res: ServerResponse,
  config: ClawdisConfig,
): Promise<void> {
  let body: unknown;
  try {
    body = await readBody(req);
  } catch (err) {
    jsonResponse(res, 400, { ok: false, error: formatError(err) });
    return;
  }

  const entry = body as Partial<McpServerConfig>;
  if (!entry.name || typeof entry.name !== "string") {
    jsonResponse(res, 400, { ok: false, error: "name is required" });
    return;
  }
  if (!entry.transport || typeof entry.transport !== "object") {
    jsonResponse(res, 400, { ok: false, error: "transport is required" });
    return;
  }
  const transport = entry.transport as {
    type?: string;
    command?: string;
    url?: string;
  };
  if (transport.type !== "stdio" && transport.type !== "sse") {
    jsonResponse(res, 400, {
      ok: false,
      error: "transport.type must be 'stdio' or 'sse'",
    });
    return;
  }
  if (transport.type === "stdio" && !transport.command) {
    jsonResponse(res, 400, {
      ok: false,
      error: "transport.command is required for stdio",
    });
    return;
  }
  if (transport.type === "sse" && !transport.url) {
    jsonResponse(res, 400, {
      ok: false,
      error: "transport.url is required for sse",
    });
    return;
  }

  const existing = (config.mcp_servers ?? []).find(
    (s) => s.name === entry.name,
  );
  if (existing) {
    jsonResponse(res, 409, {
      ok: false,
      error: `Server "${entry.name}" already configured`,
    });
    return;
  }

  const newServer: McpServerConfig = {
    name: entry.name,
    transport: entry.transport as McpServerConfig["transport"],
    env: Array.isArray(entry.env) ? entry.env : undefined,
    timeout_secs:
      typeof entry.timeout_secs === "number" ? entry.timeout_secs : undefined,
  };

  const updated: ClawdisConfig = {
    ...config,
    mcp_servers: [...(config.mcp_servers ?? []), newServer],
  };

  try {
    await writeConfigFile(updated);
  } catch (err) {
    jsonResponse(res, 500, {
      ok: false,
      error: `Failed to save config: ${formatError(err)}`,
    });
    return;
  }

  // Connect the new server into the running manager (non-blocking — errors are logged)
  void getMcpManager().init([newServer]);

  jsonResponse(res, 200, { ok: true, server: newServer });
}

// ─── DELETE /api/mcp/servers/:name ───────────────────────────────────────────

export async function handleMcpRemove(
  res: ServerResponse,
  name: string,
  config: ClawdisConfig,
): Promise<void> {
  const existing = (config.mcp_servers ?? []).find((s) => s.name === name);
  if (!existing) {
    jsonResponse(res, 404, { ok: false, error: `Server "${name}" not found` });
    return;
  }

  const updated: ClawdisConfig = {
    ...config,
    mcp_servers: (config.mcp_servers ?? []).filter((s) => s.name !== name),
  };

  try {
    await writeConfigFile(updated);
  } catch (err) {
    jsonResponse(res, 500, {
      ok: false,
      error: `Failed to save config: ${formatError(err)}`,
    });
    return;
  }

  // Rebuild manager with updated server list (disposes old connections cleanly)
  resetMcpManager();
  void getMcpManager().init(updated.mcp_servers ?? []);

  jsonResponse(res, 200, { ok: true, name });
}
