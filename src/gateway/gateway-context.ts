/**
 * GatewayContext — centralised mutable state for the Gateway server.
 *
 * All Maps, counters, and flags that were previously scattered as `let`/`const`
 * locals inside `startGatewayServer()` are collected here so they can be
 * injected into handler functions cleanly.
 */

import type { WebSocket } from "ws";
import type { ConnectParams } from "./protocol/index.js";
import type { HealthSummary } from "../commands/health.js";
import type { CronService } from "../cron/service.js";

// ─── Client type ─────────────────────────────────────────────────────────────

export type Client = {
  socket: WebSocket;
  connect: ConnectParams;
  connId: string;
  presenceKey?: string;
};

// ─── DedupeEntry ─────────────────────────────────────────────────────────────

export type DedupeEntry = {
  ts: number;
  ok: boolean;
  payload?: unknown;
  error?: import("./protocol/index.js").ErrorShape;
};

// ─── WsInflight entries ───────────────────────────────────────────────────────

export type WsInflightEntry = {
  ts: number;
  method?: string;
  meta?: Record<string, unknown>;
};

// ─── ChatAbortEntry ───────────────────────────────────────────────────────────

export type ChatAbortEntry = {
  controller: AbortController;
  sessionId: string;
  sessionKey: string;
};

// ─── ChatRunEntry ─────────────────────────────────────────────────────────────

export type ChatRunEntry = {
  sessionKey: string;
  clientRunId: string;
};

// ─── AuditEntry ──────────────────────────────────────────────────────────────

export type AuditEntry = {
  seq: number;
  timestamp: string;
  action: string;
  detail: string;
  agent_id: string | null;
};

// ─── TelegramRuntime ─────────────────────────────────────────────────────────

export type TelegramRuntime = {
  running: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  mode?: "webhook" | "polling" | null;
};

// ─── GatewayContext class ─────────────────────────────────────────────────────

export class GatewayContext {
  // ── version counters ──────────────────────────────────────────────────────
  presenceVersion = 1;
  healthVersion = 1;

  // ── health cache ──────────────────────────────────────────────────────────
  healthCache: HealthSummary | null = null;
  healthRefresh: Promise<HealthSummary> | null = null;
  broadcastHealthUpdate: ((snap: HealthSummary) => void) | null = null;

  // ── connected WebSocket clients ───────────────────────────────────────────
  readonly clients = new Set<Client>();

  // ── global event sequence counter ─────────────────────────────────────────
  seq = 0;

  // ── agent run sequence tracking (detect out-of-order events) ─────────────
  readonly agentRunSeq = new Map<string, number>();

  // ── deduplication ring buffer ─────────────────────────────────────────────
  readonly dedupe = new Map<string, DedupeEntry>();

  // ── chat runs: map runId -> queue of pending {sessionKey, clientRunId} ────
  readonly chatRunSessions = new Map<string, ChatRunEntry[]>();

  // ── chat text delta buffers (runId -> accumulated text) ───────────────────
  readonly chatRunBuffers = new Map<string, string>();

  // ── throttle timestamps for delta sends (runId -> lastSentAt) ─────────────
  readonly chatDeltaSentAt = new Map<string, number>();

  // ── abort controllers for in-flight chat.send requests ───────────────────
  readonly chatAbortControllers = new Map<string, ChatAbortEntry>();

  // ── WS inflight tracking maps (for log timing) ────────────────────────────
  readonly wsInflightSince = new Map<string, number>();
  readonly wsInflightCompact = new Map<string, WsInflightEntry>();
  readonly wsInflightOptimized = new Map<string, number>();
  wsLastCompactConnId: string | undefined = undefined;

  // ── bridge node subscriptions ─────────────────────────────────────────────
  readonly bridgeNodeSubscriptions = new Map<string, Set<string>>();
  readonly bridgeSessionSubscribers = new Map<string, Set<string>>();

  // ── Telegram provider state ───────────────────────────────────────────────
  telegramAbort: AbortController | null = null;
  telegramTask: Promise<unknown> | null = null;
  telegramStarting = false;
  telegramRuntime: TelegramRuntime = {
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
    mode: null,
  };

  // ── Audit log ring buffer ─────────────────────────────────────────────────
  readonly auditLog: AuditEntry[] = [];
  auditSeq = 0;
  readonly sseClients = new Set<import("node:http").ServerResponse>();

  // ── CronService (set after construction) ──────────────────────────────────
  cron: CronService | null = null;

  // ─── Chat run helpers ─────────────────────────────────────────────────────

  addChatRun(sessionId: string, entry: ChatRunEntry): void {
    const queue = this.chatRunSessions.get(sessionId);
    if (queue) {
      queue.push(entry);
    } else {
      this.chatRunSessions.set(sessionId, [entry]);
    }
  }

  peekChatRun(sessionId: string): ChatRunEntry | undefined {
    return this.chatRunSessions.get(sessionId)?.[0];
  }

  shiftChatRun(sessionId: string): ChatRunEntry | undefined {
    const queue = this.chatRunSessions.get(sessionId);
    if (!queue || queue.length === 0) return undefined;
    const entry = queue.shift();
    if (!queue.length) this.chatRunSessions.delete(sessionId);
    return entry;
  }

  removeChatRun(
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ): ChatRunEntry | undefined {
    const queue = this.chatRunSessions.get(sessionId);
    if (!queue || queue.length === 0) return undefined;
    const idx = queue.findIndex(
      (entry) =>
        entry.clientRunId === clientRunId &&
        (sessionKey ? entry.sessionKey === sessionKey : true),
    );
    if (idx < 0) return undefined;
    const [entry] = queue.splice(idx, 1);
    if (!queue.length) this.chatRunSessions.delete(sessionId);
    return entry;
  }

  // ─── Audit log helpers ────────────────────────────────────────────────────

  appendAudit(action: string, detail: string, agentId?: string | null): void {
    const entry: AuditEntry = {
      seq: ++this.auditSeq,
      timestamp: new Date().toISOString(),
      action,
      detail: detail ?? "",
      agent_id: agentId ?? null,
    };
    this.auditLog.push(entry);
    if (this.auditLog.length > 500) {
      this.auditLog.splice(0, this.auditLog.length - 500);
    }
    const data = `data: ${JSON.stringify(entry)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(data);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  // ─── Cleanup / dispose ────────────────────────────────────────────────────

  dispose(): void {
    this.clients.clear();
    this.agentRunSeq.clear();
    this.dedupe.clear();
    this.chatRunSessions.clear();
    this.chatRunBuffers.clear();
    this.chatDeltaSentAt.clear();
    this.chatAbortControllers.clear();
    this.wsInflightSince.clear();
    this.wsInflightCompact.clear();
    this.wsInflightOptimized.clear();
    this.bridgeNodeSubscriptions.clear();
    this.bridgeSessionSubscribers.clear();
    this.sseClients.clear();
  }
}
