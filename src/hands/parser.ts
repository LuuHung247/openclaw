/**
 * HAND.md Parser — Parse HAND.md files with YAML frontmatter
 *
 * Format:
 * ---
 * id: server-monitor
 * name: Server Monitor
 * ...
 * ---
 *
 * # Hand Name
 *
 * System prompt body...
 */

import type { HandDefinition } from "./types.js";
import { readFileSync } from "node:fs";

/**
 * Simple YAML frontmatter parser (minimal implementation)
 * Handles key: value, arrays with [[array]] syntax, and nested objects
 */
function parseSimpleYAML(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split("\n");
  let currentObj = result;
  const stack: Array<{ obj: Record<string, unknown>; key: string }> = [];

  for (let line of lines) {
    line = line.trimRight();

    // Skip empty lines and comments
    if (!line || line.startsWith("#")) continue;

    // Handle nesting ([[array]] or [object])
    const arrayMatch = line.match(/^\[\[([a-z_]+)\]\]$/i);
    if (arrayMatch) {
      const key = arrayMatch[1];
      if (!Array.isArray(currentObj[key])) {
        currentObj[key] = [];
      }
      const newEntry: Record<string, unknown> = {};
      (currentObj[key] as Array<Record<string, unknown>>).push(newEntry);
      stack.push({ obj: currentObj, key });
      currentObj = newEntry;
      continue;
    }

    // Handle end of nested object
    if (line.startsWith("[") && line.endsWith("]")) {
      if (stack.length > 0) {
        const parent = stack.pop();
        if (parent) {
          currentObj = parent.obj as Record<string, unknown>;
        }
      }
      continue;
    }

    // Handle key: value pairs
    const colonIndex = line.indexOf(":");
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      let value: string | boolean | number = line.slice(colonIndex + 1).trim();

      // Handle different value types
      if (value === "true") {
        value = true;
      } else if (value === "false") {
        value = false;
      } else if (value === "") {
        value = "";
      } else if (!isNaN(Number(value))) {
        value = Number(value);
      } else if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      } else if (value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1);
      }

      currentObj[key] = value;
    }
  }

  return result;
}

/**
 * Parse a HAND.md file and return a HandDefinition
 */
export function parseHandMD(
  filePath: string,
  content: string,
): HandDefinition | { error: string } {
  // Split frontmatter and body
  const frontmatterMatch = content.match(/^---\n([\s\S]+?)\n---\n([\s\S]*)$/);
  if (!frontmatterMatch) {
    return { error: "Invalid HAND.md: missing YAML frontmatter" };
  }

  const frontmatterText = frontmatterMatch[1];
  const body = frontmatterMatch[2].trim();

  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseSimpleYAML(frontmatterText);
  } catch (err) {
    return { error: `Invalid YAML frontmatter: ${String(err)}` };
  }

  if (!frontmatter || typeof frontmatter !== "object") {
    return { error: "Invalid frontmatter: not an object" };
  }

  const fm = frontmatter as Record<string, unknown>;

  // Validate required fields
  const id = fm.id;
  const name = fm.name;
  const description = fm.description;
  const category = fm.category;
  const icon = fm.icon ?? "🤖";

  if (typeof id !== "string" || !id) {
    return { error: "Missing or invalid 'id' field" };
  }
  if (typeof name !== "string" || !name) {
    return { error: "Missing or invalid 'name' field" };
  }
  if (typeof description !== "string" || !description) {
    return { error: "Missing or invalid 'description' field" };
  }
  if (typeof category !== "string" || !category) {
    return { error: "Missing or invalid 'category' field" };
  }
  if (typeof icon !== "string") {
    return { error: "Invalid 'icon' field" };
  }

  // Parse requires array
  const requires: Array<Record<string, unknown>> = [];
  if (Array.isArray(fm.requires)) {
    for (const req of fm.requires) {
      if (req && typeof req === "object") {
        requires.push(req as Record<string, unknown>);
      }
    }
  }

  // Parse settings array
  const settings: Array<Record<string, unknown>> = [];
  if (Array.isArray(fm.settings)) {
    for (const setting of fm.settings) {
      if (setting && typeof setting === "object") {
        settings.push(setting as Record<string, unknown>);
      }
    }
  }

  // Parse agent config
  let agent = {
    model: "default",
    temperature: 0.2,
    max_iterations: undefined as number | undefined,
    timeout_seconds: 120,
  };
  if (fm.agent && typeof fm.agent === "object") {
    const agentObj = fm.agent as Record<string, unknown>;
    if (typeof agentObj.model === "string") {
      agent.model = agentObj.model;
    }
    if (typeof agentObj.temperature === "number") {
      agent.temperature = agentObj.temperature;
    }
    if (typeof agentObj.max_iterations === "number") {
      agent.max_iterations = agentObj.max_iterations;
    }
    if (typeof agentObj.timeout_seconds === "number") {
      agent.timeout_seconds = agentObj.timeout_seconds;
    }
  }

  // Parse dashboard metrics
  const dashboard: Array<Record<string, unknown>> = [];
  if (Array.isArray(fm.dashboard)) {
    for (const metric of fm.dashboard) {
      if (metric && typeof metric === "object") {
        dashboard.push(metric as Record<string, unknown>);
      }
    }
  }

  return {
    id,
    name,
    description,
    category,
    icon,
    requires: requires.map((req) => ({
      key: String(req.key ?? ""),
      label: String(req.label ?? ""),
      type: (req.type as "binary" | "env" | "api-key" | "file") ?? "binary",
      check: String(req.check ?? ""),
    })),
    settings: settings.map((setting) => {
      const s: {
        key: string;
        label: string;
        description?: string;
        type: "text" | "number" | "select" | "boolean";
        default: string | number | boolean | undefined;
        options?: { value: string; label: string }[];
      } = {
        key: String(setting.key ?? ""),
        label: String(setting.label ?? ""),
        description:
          typeof setting.description === "string" ? setting.description : undefined,
        type: (setting.type as "text" | "number" | "select" | "boolean") ??
          "text",
        default: (setting.default as string | number | boolean | undefined),
      };
      if (Array.isArray(setting.options)) {
        s.options = setting.options.map((opt) => ({
          value: String(typeof opt === "object" && opt !== null && "value" in opt ? opt.value : opt),
          label: String(typeof opt === "object" && opt !== null && "label" in opt ? opt.label : opt),
        }));
      }
      return s;
    }),
    agent,
    dashboard: dashboard.map((metric) => ({
      label: String(metric.label ?? ""),
      memory_key: String(metric.memory_key ?? ""),
      format: (metric.format as "number" | "text" | "datetime" | "duration") ?? "text",
    })),
    systemPrompt: body,
  };
}

/**
 * Load and parse a HAND.md file from disk
 */
export function loadHandMD(filePath: string): HandDefinition | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const result = parseHandMD(filePath, content);
    if ("error" in result) {
      console.warn(`[hands] failed to parse "${filePath}": ${result.error}`);
      return null;
    }
    return result;
  } catch (err) {
    console.warn(`[hands] failed to load "${filePath}": ${err}`);
    return null;
  }
}

/**
 * Scan a directory for HAND.md files and load them
 */
export function loadHandsFromDirectory(dirPath: string): HandDefinition[] {
  const { readdirSync, statSync } = require("node:fs");
  const { join } = require("node:path");

  const hands: HandDefinition[] = [];

  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Look for HAND.md in subdirectory
        const handPath = join(dirPath, entry.name, "HAND.md");
        if (statSync(handPath).isFile()) {
          const hand = loadHandMD(handPath);
          if (hand) hands.push(hand);
        }
      } else if (entry.name === "HAND.md") {
        // HAND.md directly in this directory
        const hand = loadHandMD(join(dirPath, entry.name));
        if (hand) hands.push(hand);
      }
    }
  } catch (err) {
    console.warn(`[hands] failed to scan directory "${dirPath}": ${err}`);
  }

  return hands;
}
