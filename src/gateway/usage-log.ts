/**
 * Usage log — JSONL file tracking per-agent-run token consumption.
 *
 * Extracted from server.ts to be shared by server + usage handlers.
 */

import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../utils.js";

export const USAGE_LOG_PATH = path.join(CONFIG_DIR, "usage-log.jsonl");

export type UsageLogEntry = {
  ts: string;        // ISO date string
  date: string;      // YYYY-MM-DD
  sessionKey: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  tool_calls: number;
  duration_ms?: number;
};

export function appendUsageEvent(entry: UsageLogEntry): void {
  try {
    fs.appendFileSync(USAGE_LOG_PATH, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // non-fatal — analytics log failure should not break normal operation
  }
}

export function readUsageLog(): UsageLogEntry[] {
  try {
    if (!fs.existsSync(USAGE_LOG_PATH)) return [];
    const lines = fs
      .readFileSync(USAGE_LOG_PATH, "utf-8")
      .split("\n")
      .filter(Boolean);
    return lines
      .map((l) => {
        try {
          return JSON.parse(l) as UsageLogEntry;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as UsageLogEntry[];
  } catch {
    return [];
  }
}
