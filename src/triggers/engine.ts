/**
 * Trigger Engine — Event-driven automation
 *
 * TriggerDefinition:
 *   pattern: TriggerPattern — event matching
 *   action: TriggerAction — what to do when trigger fires
 *
 * TriggerPattern types:
 *   - cron_finished: cron job completion
 *   - hand_event: hand lifecycle events
 *   - content_match: message content matching
 *   - webhook: HTTP webhook trigger
 *   - file_change: file system changes
 *
 * TriggerAction types:
 *   - notify: send notification
 *   - run_workflow: execute workflow
 *   - agent_message: send message to agent session
 *   - bash: execute bash command
 */

import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import JSON5 from "json5";

export type TriggerPattern =
  | { kind: "cron_finished"; jobId?: string; status?: "ok" | "error" }
  | {
      kind: "hand_event";
      handId?: string;
      event?: "activated" | "deactivated" | "paused" | "resumed" | "error";
    }
  | { kind: "content_match"; substring: string; sessionKey?: string }
  | { kind: "webhook"; path: string }
  | { kind: "file_change"; glob: string };

export type TriggerAction =
  | { kind: "notify"; channel: "telegram" | "lark"; message: string }
  | { kind: "run_workflow"; workflowId: string; input?: Record<string, string> }
  | { kind: "agent_message"; sessionKey: string; prompt: string }
  | { kind: "bash"; command: string };

export type TriggerDefinition = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  pattern: TriggerPattern;
  action: TriggerAction;
  cooldownMs?: number; // minimum time between fires
  createdAtMs: number;
  updatedAtMs: number;
};

export type TriggerFire = {
  fireId: string;
  triggerId: string;
  firedAt: number;
  eventData: Record<string, unknown>;
  status: "pending" | "executed" | "failed";
  result?: string;
  error?: string;
};

const TRIGGERS_DIR = join(process.env.HOME ?? "", ".clawdis", "triggers");
const TRIGGERS_FILE = join(TRIGGERS_DIR, "triggers.json5");
const FIRES_FILE = join(TRIGGERS_DIR, "fires.jsonl");

export interface TriggerEngineConfig {
  triggersDir?: string;
  triggersFile?: string;
  firesFile?: string;
  runAction: (
    action: TriggerAction,
    eventData: Record<string, unknown>,
  ) => Promise<{ ok: boolean; result?: string; error?: string }>;
  emitEvent?: (event: string, payload: unknown) => void;
}

export class TriggerEngine {
  private readonly config: Omit<TriggerEngineConfig, "emitEvent"> & {
    emitEvent: (event: string, payload: unknown) => void;
  };
  private triggers: Map<string, TriggerDefinition> = new Map();
  private fires: Map<string, TriggerFire> = new Map();
  private lastFireTimes: Map<string, number> = new Map();

  constructor(config?: TriggerEngineConfig) {
    this.config = {
      triggersDir: config?.triggersDir ?? TRIGGERS_DIR,
      triggersFile: config?.triggersFile ?? TRIGGERS_FILE,
      firesFile: config?.firesFile ?? FIRES_FILE,
      runAction:
        config?.runAction ??
        (async () => ({ ok: false, error: "Not implemented" })),
      emitEvent: config?.emitEvent ?? (() => {}),
    };
  }

  async loadTriggers(): Promise<void> {
    this.triggers.clear();

    const triggersFile = this.config.triggersFile;
    if (!triggersFile || !existsSync(triggersFile)) {
      return;
    }

    try {
      const content = readFileSync(triggersFile, "utf-8");
      const data = JSON5.parse(content) as { triggers?: TriggerDefinition[] };
      if (Array.isArray(data.triggers)) {
        for (const trigger of data.triggers) {
          this.triggers.set(trigger.id, trigger);
        }
      }
    } catch (err) {
      console.warn(`[triggers] failed to load triggers: ${err}`);
    }
  }

  async saveTriggers(): Promise<void> {
    try {
      const triggersFile = this.config.triggersFile;
      if (!triggersFile) {
        throw new Error("triggersFile is not configured");
      }
      const dir = dirname(triggersFile);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const data = {
        version: 1,
        triggers: Array.from(this.triggers.values()),
      };
      writeFileSync(triggersFile, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error(`[triggers] failed to save triggers: ${err}`);
      throw err;
    }
  }

  async loadFires(): Promise<void> {
    this.fires.clear();

    const firesFile = this.config.firesFile;
    if (!firesFile || !existsSync(firesFile)) {
      return;
    }

    try {
      const content = readFileSync(firesFile, "utf-8");
      const lines = content.trim().split("\n");
      for (const line of lines) {
        if (!line) continue;
        const fire = JSON5.parse(line) as TriggerFire;
        this.fires.set(fire.fireId, fire);
      }
    } catch (err) {
      console.warn(`[triggers] failed to load fires: ${err}`);
    }
  }

  async appendFire(fire: TriggerFire): Promise<void> {
    this.fires.set(fire.fireId, fire);
    try {
      const firesFile = this.config.firesFile;
      if (!firesFile) {
        throw new Error("firesFile is not configured");
      }
      const dir = dirname(firesFile);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const line = `${JSON.stringify(fire)}\n`;
      const { appendFileSync } = require("node:fs");
      appendFileSync(firesFile, line);
    } catch (err) {
      console.error(`[triggers] failed to append fire: ${err}`);
    }
  }

  getTrigger(id: string): TriggerDefinition | undefined {
    return this.triggers.get(id);
  }

  listTriggers(includeDisabled = false): TriggerDefinition[] {
    const all = Array.from(this.triggers.values());
    if (includeDisabled) return all;
    return all.filter((t) => t.enabled);
  }

  async createTrigger(
    def: Omit<TriggerDefinition, "id" | "createdAtMs" | "updatedAtMs">,
  ): Promise<TriggerDefinition> {
    const id = crypto.randomUUID();
    const now = Date.now();
    const trigger: TriggerDefinition = {
      ...def,
      id,
      createdAtMs: now,
      updatedAtMs: now,
    };
    this.triggers.set(id, trigger);
    await this.saveTriggers();
    return trigger;
  }

  async updateTrigger(
    id: string,
    updates: Partial<Omit<TriggerDefinition, "id" | "createdAtMs">>,
  ): Promise<TriggerDefinition | undefined> {
    const trigger = this.triggers.get(id);
    if (!trigger) return undefined;

    const updated: TriggerDefinition = {
      ...trigger,
      ...updates,
      id,
      updatedAtMs: Date.now(),
    };
    this.triggers.set(id, updated);
    await this.saveTriggers();
    return updated;
  }

  async deleteTrigger(id: string): Promise<boolean> {
    const deleted = this.triggers.delete(id);
    if (deleted) {
      await this.saveTriggers();
    }
    return deleted;
  }

  listFires(triggerId?: string, limit = 100): TriggerFire[] {
    const all = Array.from(this.fires.values()).sort(
      (a, b) => b.firedAt - a.firedAt,
    );
    if (triggerId) {
      return all.filter((f) => f.triggerId === triggerId).slice(0, limit);
    }
    return all.slice(0, limit);
  }

  /**
   * Evaluate an event against all triggers and fire matching ones
   */
  async evaluateEvent(
    event: string,
    eventData: Record<string, unknown>,
  ): Promise<void> {
    const enabledTriggers = this.listTriggers(false);

    for (const trigger of enabledTriggers) {
      if (this.matchesPattern(trigger.pattern, event, eventData)) {
        await this.fireTrigger(trigger.id, eventData);
      }
    }
  }

  /**
   * Check if a trigger pattern matches an event
   */
  private matchesPattern(
    pattern: TriggerPattern,
    event: string,
    eventData: Record<string, unknown>,
  ): boolean {
    switch (pattern.kind) {
      case "cron_finished":
        if (event !== "cron.finished") return false;
        if (pattern.jobId && eventData.jobId !== pattern.jobId) return false;
        if (pattern.status && eventData.status !== pattern.status) return false;
        return true;

      case "hand_event":
        if (event !== "hand.event") return false;
        if (pattern.handId && eventData.handId !== pattern.handId) return false;
        if (pattern.event && eventData.event !== pattern.event) return false;
        return true;

      case "content_match": {
        if (event !== "agent.message" && event !== "agent.done") return false;
        const content = String(eventData.content || eventData.message || "");
        if (!content.includes(pattern.substring)) return false;
        if (pattern.sessionKey && eventData.sessionKey !== pattern.sessionKey)
          return false;
        return true;
      }

      case "webhook":
        if (event !== "webhook.received") return false;
        if (eventData.path !== pattern.path) return false;
        return true;

      case "file_change": {
        if (event !== "file.changed") return false;
        // Simple glob matching
        const filePath = String(eventData.path || "");
        const glob = pattern.glob.replace("*", ".*");
        const regex = new RegExp(glob);
        return regex.test(filePath);
      }

      default:
        return false;
    }
  }

  /**
   * Fire a trigger (execute its action)
   */
  async fireTrigger(
    triggerId: string,
    eventData: Record<string, unknown>,
  ): Promise<TriggerFire | null> {
    const trigger = this.triggers.get(triggerId);
    if (!trigger || !trigger.enabled) {
      return null;
    }

    // Check cooldown
    const now = Date.now();
    const lastFire = this.lastFireTimes.get(triggerId);
    if (lastFire && trigger.cooldownMs && now - lastFire < trigger.cooldownMs) {
      return null; // Still in cooldown
    }

    this.lastFireTimes.set(triggerId, now);

    const fireId = crypto.randomUUID();
    const fire: TriggerFire = {
      fireId,
      triggerId,
      firedAt: now,
      eventData,
      status: "pending",
    };

    await this.appendFire(fire);
    this.config.emitEvent?.("trigger.fired", { fireId, triggerId });

    try {
      const result = await this.config.runAction(trigger.action, eventData);
      fire.status = result.ok ? "executed" : "failed";
      fire.result = result.result;
      fire.error = result.error;
    } catch (err) {
      fire.status = "failed";
      fire.error = String(err);
    }

    await this.appendFire(fire);
    this.config.emitEvent?.("trigger.finished", {
      fireId,
      status: fire.status,
    });
    return fire;
  }
}

/**
 * Global trigger engine instance
 */
let globalEngine: TriggerEngine | null = null;

export function getGlobalTriggerEngine(): TriggerEngine {
  if (!globalEngine) {
    globalEngine = new TriggerEngine();
  }
  return globalEngine;
}

export async function initGlobalTriggerEngine(
  config?: TriggerEngineConfig,
): Promise<TriggerEngine> {
  const engine = new TriggerEngine(config);
  await engine.loadTriggers();
  await engine.loadFires();
  globalEngine = engine;
  return engine;
}
