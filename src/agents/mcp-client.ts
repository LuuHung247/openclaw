/**
 * MCP client — connects to a single MCP server via stdio or SSE transport.
 *
 * Protocol: JSON-RPC 2.0, MCP spec 2024-11-05.
 * Lifecycle: connect() → initialize handshake → tools/list → call_tool() → dispose()
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { McpServerConfig } from "../config/config.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export type McpToolDefinition = {
  /** Namespaced name: mcp_{server}_{tool} */
  name: string;
  /** Original tool name from the MCP server */
  originalName: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpServerStatus = {
  name: string;
  connected: boolean;
  tools: McpToolDefinition[];
  error?: string;
};

// ─── Internal types ───────────────────────────────────────────────────────────

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number | null;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

// ─── Name normalisation ───────────────────────────────────────────────────────

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-\s]+/g, "_");
}

export function formatMcpToolName(serverName: string, toolName: string): string {
  return `mcp_${normalizeName(serverName)}_${normalizeName(toolName)}`;
}

export function isMcpTool(name: string): boolean {
  return name.startsWith("mcp_");
}

// ─── McpClient ────────────────────────────────────────────────────────────────

export class McpClient {
  private readonly config: McpServerConfig;
  private readonly timeoutMs: number;

  private tools: McpToolDefinition[] = [];
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();

  // stdio transport state
  private proc: ChildProcessWithoutNullStreams | null = null;
  private stdioBuffer = "";

  constructor(config: McpServerConfig) {
    this.config = config;
    this.timeoutMs = (config.timeout_secs ?? 30) * 1000;
  }

  get serverName(): string {
    return this.config.name;
  }

  get discoveredTools(): McpToolDefinition[] {
    return this.tools;
  }

  // ─── Connection ─────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.config.transport.type === "stdio") {
      await this.connectStdio();
    } else {
      // SSE transport uses HTTP POST — no persistent connection needed
    }
    await this.initialize();
    await this.discoverTools();
  }

  private async connectStdio(): Promise<void> {
    const transport = this.config.transport;
    if (transport.type !== "stdio") return;

    const { command, args = [] } = transport;

    // Build a safe env: start clean, add PATH + whitelisted vars only
    const safeEnv: Record<string, string> = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" };
    for (const key of this.config.env ?? []) {
      const val = process.env[key];
      if (val !== undefined) safeEnv[key] = val;
    }

    this.proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: safeEnv,
    });

    this.proc.stderr.on("data", (chunk: Buffer) => {
      console.warn(`[mcp:${this.config.name}] stderr: ${chunk.toString().trim()}`);
    });

    this.proc.stdout.on("data", (chunk: Buffer) => {
      this.stdioBuffer += chunk.toString();
      this.flushStdioBuffer();
    });

    this.proc.on("exit", (code) => {
      console.warn(`[mcp:${this.config.name}] process exited (code=${code})`);
      this.rejectAllPending(new Error(`MCP server exited (code=${code})`));
    });

    // Give the process a moment to start up
    await new Promise<void>((r) => setTimeout(r, 200));
  }

  private flushStdioBuffer(): void {
    let nl = this.stdioBuffer.indexOf("\n");
    while (nl !== -1) {
      const line = this.stdioBuffer.slice(0, nl).trim();
      this.stdioBuffer = this.stdioBuffer.slice(nl + 1);
      if (line) this.handleIncomingLine(line);
      nl = this.stdioBuffer.indexOf("\n");
    }
  }

  private handleIncomingLine(line: string): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return; // ignore non-JSON lines (e.g. startup banners)
    }
    if (msg.id == null) return; // notification — ignore
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(msg.id);
    if (msg.error) {
      pending.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
    } else {
      pending.resolve(msg.result);
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  // ─── JSON-RPC send ────────────────────────────────────────────────────────

  private async sendRequest(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const json = JSON.stringify(req);

    if (this.config.transport.type === "stdio") {
      return this.sendStdio(id, json);
    }
    return this.sendSse(json);
  }

  private sendStdio(id: number, json: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.proc.killed) {
        reject(new Error("MCP process not running"));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out (${this.timeoutMs}ms)`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(`${json}\n`);
    });
  }

  private async sendSse(json: string): Promise<unknown> {
    const transport = this.config.transport;
    if (transport.type !== "sse") throw new Error("Not SSE transport");

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);

    try {
      const res = await fetch(transport.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: json,
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as JsonRpcResponse;
      if (body.error) throw new Error(`MCP error ${body.error.code}: ${body.error.message}`);
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  }

  private sendNotification(method: string, params?: unknown): void {
    const msg: JsonRpcRequest = { jsonrpc: "2.0", id: null, method, params };
    const json = JSON.stringify(msg);
    if (this.config.transport.type === "stdio" && this.proc && !this.proc.killed) {
      this.proc.stdin.write(`${json}\n`);
    }
    // SSE notifications not needed — server is stateless per-request
  }

  // ─── MCP protocol ─────────────────────────────────────────────────────────

  private async initialize(): Promise<void> {
    await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: { name: "openclaw", version: "1.0.0" },
    });
    this.sendNotification("notifications/initialized");
  }

  private async discoverTools(): Promise<void> {
    const result = await this.sendRequest("tools/list") as { tools?: unknown[] };
    const raw = result?.tools ?? [];
    this.tools = raw
      .filter((t): t is { name: string; description?: string; inputSchema?: unknown } =>
        typeof t === "object" && t !== null && typeof (t as { name?: unknown }).name === "string",
      )
      .map((t) => ({
        name: formatMcpToolName(this.config.name, t.name),
        originalName: t.name,
        description: t.description ?? "",
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
      }));
  }

  // ─── Tool execution ───────────────────────────────────────────────────────

  async callTool(originalName: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.sendRequest("tools/call", {
      name: originalName,
      arguments: args,
    }) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };

    const content = result?.content ?? [];
    const text = content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");

    if (result?.isError) {
      throw new Error(text || "Tool returned an error");
    }
    return text;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  dispose(): void {
    this.rejectAllPending(new Error("MCP client disposed"));
    if (this.proc && !this.proc.killed) {
      try { this.proc.kill(); } catch { /* ignore */ }
    }
    this.proc = null;
  }
}
