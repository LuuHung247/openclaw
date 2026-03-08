/**
 * McpManager — singleton that owns all MCP server connections for the gateway.
 *
 * Responsibilities:
 * - Load mcp_servers from ClawdisConfig on init
 * - Connect each server (with error isolation — one failure doesn't block others)
 * - Expose aggregated tool list for agent toolset injection
 * - Re-expose per-server status for the REST API
 * - Dispose all connections on shutdown
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

import type { McpServerConfig } from "../config/config.js";
import {
  formatMcpToolName,
  isMcpTool,
  McpClient,
  type McpServerStatus,
  type McpToolDefinition,
} from "./mcp-client.js";

// biome-ignore lint/suspicious/noExplicitAny: TypeBox schema type uses a different module instance
type AnyAgentTool = AgentTool<any, unknown>;

// ─── McpManager ──────────────────────────────────────────────────────────────

export class McpManager {
  private clients = new Map<string, McpClient>();
  private errors = new Map<string, string>();

  // ─── Init / shutdown ──────────────────────────────────────────────────────

  /**
   * Connect to all configured MCP servers concurrently.
   * Per-server failures are logged and stored; they don't throw.
   */
  async init(servers: McpServerConfig[]): Promise<void> {
    await Promise.all(servers.map((cfg) => this.connectServer(cfg)));
  }

  private async connectServer(cfg: McpServerConfig): Promise<void> {
    const client = new McpClient(cfg);
    try {
      await client.connect();
      this.clients.set(cfg.name, client);
      console.info(
        `[mcp] connected "${cfg.name}" — ${client.discoveredTools.length} tool(s)`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.errors.set(cfg.name, msg);
      console.warn(`[mcp] failed to connect "${cfg.name}": ${msg}`);
      client.dispose();
    }
  }

  dispose(): void {
    for (const client of this.clients.values()) {
      client.dispose();
    }
    this.clients.clear();
    this.errors.clear();
  }

  // ─── Tool access ──────────────────────────────────────────────────────────

  /** All MCP tools across all connected servers, as agent-compatible tools. */
  buildAgentTools(): AnyAgentTool[] {
    const tools: AnyAgentTool[] = [];
    for (const client of this.clients.values()) {
      for (const def of client.discoveredTools) {
        tools.push(buildAgentTool(def, client));
      }
    }
    return tools;
  }

  /** All discovered tool definitions (for status API). */
  allToolDefinitions(): McpToolDefinition[] {
    const defs: McpToolDefinition[] = [];
    for (const client of this.clients.values()) {
      defs.push(...client.discoveredTools);
    }
    return defs;
  }

  /**
   * Route a tool call to the correct MCP server.
   * Returns null if the tool name is not an MCP tool.
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string | null> {
    if (!isMcpTool(toolName)) return null;

    // Find which client owns this tool
    for (const client of this.clients.values()) {
      const def = client.discoveredTools.find((d) => d.name === toolName);
      if (def) {
        return client.callTool(def.originalName, args);
      }
    }
    return null;
  }

  // ─── Status API ───────────────────────────────────────────────────────────

  serverStatuses(configuredServers: McpServerConfig[]): McpServerStatus[] {
    return configuredServers.map((cfg) => {
      const client = this.clients.get(cfg.name);
      const error = this.errors.get(cfg.name);
      if (client) {
        return {
          name: cfg.name,
          connected: true,
          tools: client.discoveredTools,
        };
      }
      return {
        name: cfg.name,
        connected: false,
        tools: [],
        error,
      };
    });
  }
}

// ─── Global singleton (shared by gateway + agent runtime) ────────────────────

let _instance: McpManager | null = null;

export function getMcpManager(): McpManager {
  if (!_instance) _instance = new McpManager();
  return _instance;
}

export function resetMcpManager(): void {
  _instance?.dispose();
  _instance = null;
}

// ─── Agent tool builder ───────────────────────────────────────────────────────

function buildAgentTool(def: McpToolDefinition, client: McpClient): AnyAgentTool {
  // Build a TypeBox schema from the MCP inputSchema properties
  const properties = (def.inputSchema?.properties as Record<string, unknown>) ?? {};
  const required = Array.isArray(def.inputSchema?.required)
    ? (def.inputSchema.required as string[])
    : [];

  const schemaProps: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(properties)) {
    const prop = val as { type?: string; description?: string };
    if (prop.type === "string") {
      schemaProps[key] = prop.description
        ? Type.String({ description: prop.description })
        : Type.String();
    } else if (prop.type === "number" || prop.type === "integer") {
      schemaProps[key] = prop.description
        ? Type.Number({ description: prop.description })
        : Type.Number();
    } else if (prop.type === "boolean") {
      schemaProps[key] = Type.Boolean();
    } else {
      // Fallback: accept any string (agent will pass JSON-encoded value)
      schemaProps[key] = Type.String();
    }
  }

  // Make non-required fields optional at the TypeBox level
  const finalProps: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schemaProps)) {
    finalProps[k] = required.includes(k) ? v : Type.Optional(v as Parameters<typeof Type.Optional>[0]);
  }

  const inputSchema =
    Object.keys(finalProps).length > 0
      ? Type.Object(finalProps as Parameters<typeof Type.Object>[0])
      : Type.Object({});

  return {
    name: def.name,
    label: `[MCP:${client.serverName}] ${def.name}`,
    description: `[MCP:${client.serverName}] ${def.description}`,
    parameters: inputSchema,
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<unknown>> => {
      try {
        const result = await client.callTool(def.originalName, params);
        return { content: [{ type: "text", text: result }], details: result };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `MCP tool error: ${msg}` }],
          details: msg,
        };
      }
    },
  };
}

// Re-export for convenience
export { formatMcpToolName, isMcpTool };
export type { McpServerStatus, McpToolDefinition };
