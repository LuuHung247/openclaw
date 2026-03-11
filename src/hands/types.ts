/**
 * Hands System — Autonomous agent packages for DevOps tasks
 *
 * Hands are similar to skills but run autonomously on a schedule instead of
 * being invoked on-demand. Each hand has a HAND.md manifest with metadata,
 * settings, and a system prompt that defines its workflow.
 */

export type HandSettingType = "text" | "number" | "select" | "boolean" | "session";

export interface HandSettingOption {
  value: string;
  label: string;
}

export interface HandSetting {
  key: string;
  label: string;
  description?: string;
  type: HandSettingType;
  default?: string | number | boolean;
  options?: HandSettingOption[];
}

export interface HandRequirement {
  key: string;
  label: string;
  type: "binary" | "env" | "api-key" | "file";
  check: string; // binary name or env var name or file path
}

export interface HandAgentConfig {
  model?: string; // "default" or specific model
  temperature?: number;
  max_iterations?: number;
  timeout_seconds?: number;
}

export interface HandDashboardMetric {
  label: string;
  memory_key: string;
  format: "number" | "text" | "datetime" | "duration";
}

export interface HandDefinition {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  requires: HandRequirement[];
  settings: HandSetting[];
  agent: HandAgentConfig;
  dashboard: HandDashboardMetric[];
  systemPrompt: string; // parsed from markdown body
}

export type HandStatus = "active" | "paused" | "error" | "inactive";

export interface HandInstance {
  instanceId: string;
  handId: string;
  status: HandStatus;
  sessionId: string; // agent session ID
  config: Record<string, string | number | boolean>; // user settings values
  cronJobIds: string[]; // linked cron jobs
  activatedAt: number;
  updatedAt: number;
  lastError?: string;
}

export interface HandActivationResult {
  instance: HandInstance;
  warnings: string[]; // e.g., "Optional requirement not met: curl"
}

export interface HandRequirementCheck {
  ok: boolean;
  met: string[];
  missing: string[];
  optional: string[];
}
