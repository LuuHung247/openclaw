/**
 * Skills handler implementations — extracted from the server.ts WS switch.
 */

import fs from "node:fs";
import path from "node:path";
import { installSkill } from "../../agents/skills-install.js";
import { buildWorkspaceSkillStatus } from "../../agents/skills-status.js";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "../../agents/workspace.js";
import type { ClawdisConfig } from "../../config/config.js";
import { writeConfigFile } from "../../config/config.js";
import { CONFIG_DIR, resolveUserPath } from "../../utils.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateSkillsInstallParams,
  validateSkillsStatusParams,
  validateSkillsUpdateParams,
} from "../protocol/index.js";

type RespondFn = (
  ok: boolean,
  payload: unknown,
  error: ReturnType<typeof errorShape> | undefined,
) => void;

type BroadcastFn = (event: string, payload: unknown) => void;

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export async function handleSkillsStatus(
  params: Record<string, unknown>,
  respond: RespondFn,
): Promise<void> {
  if (!validateSkillsStatusParams(params)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid skills.status params: ${formatValidationErrors(validateSkillsStatusParams.errors)}`,
      ),
    );
    return;
  }
  const { loadConfig } = await import("../../config/config.js");
  const cfg = loadConfig();
  const workspaceDirRaw = cfg.agent?.workspace ?? DEFAULT_AGENT_WORKSPACE_DIR;
  const workspaceDir = resolveUserPath(workspaceDirRaw);
  const report = buildWorkspaceSkillStatus(workspaceDir, { config: cfg });
  respond(true, report, undefined);
}

export async function handleSkillsInstall(
  params: Record<string, unknown>,
  respond: RespondFn,
): Promise<void> {
  if (!validateSkillsInstallParams(params)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid skills.install params: ${formatValidationErrors(validateSkillsInstallParams.errors)}`,
      ),
    );
    return;
  }
  const p = params as { name: string; installId: string; timeoutMs?: number };
  const { loadConfig } = await import("../../config/config.js");
  const cfg = loadConfig();
  const workspaceDirRaw = cfg.agent?.workspace ?? DEFAULT_AGENT_WORKSPACE_DIR;
  const result = await installSkill({
    workspaceDir: workspaceDirRaw,
    skillName: p.name,
    installId: p.installId,
    timeoutMs: p.timeoutMs,
    config: cfg,
  });
  respond(
    result.ok,
    result,
    result.ok ? undefined : errorShape(ErrorCodes.UNAVAILABLE, result.message),
  );
}

export async function handleSkillsUpdate(
  params: Record<string, unknown>,
  respond: RespondFn,
): Promise<void> {
  if (!validateSkillsUpdateParams(params)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid skills.update params: ${formatValidationErrors(validateSkillsUpdateParams.errors)}`,
      ),
    );
    return;
  }
  const p = params as {
    skillKey: string;
    enabled?: boolean;
    apiKey?: string;
    env?: Record<string, string>;
  };
  const { loadConfig } = await import("../../config/config.js");
  const cfg = loadConfig();
  const skills = cfg.skills ? { ...cfg.skills } : {};
  const entries = skills.entries ? { ...skills.entries } : {};
  const current = entries[p.skillKey] ? { ...entries[p.skillKey] } : {};
  if (typeof p.enabled === "boolean") {
    current.enabled = p.enabled;
  }
  if (typeof p.apiKey === "string") {
    const trimmed = p.apiKey.trim();
    if (trimmed) current.apiKey = trimmed;
    else delete current.apiKey;
  }
  if (p.env && typeof p.env === "object") {
    const nextEnv = current.env ? { ...current.env } : {};
    for (const [key, value] of Object.entries(p.env)) {
      const trimmedKey = key.trim();
      if (!trimmedKey) continue;
      const trimmedVal = value.trim();
      if (!trimmedVal) delete nextEnv[trimmedKey];
      else nextEnv[trimmedKey] = trimmedVal;
    }
    current.env = nextEnv;
  }
  entries[p.skillKey] = current;
  skills.entries = entries;
  const nextConfig: ClawdisConfig = { ...cfg, skills };
  await writeConfigFile(nextConfig);
  respond(true, { ok: true, skillKey: p.skillKey, config: current }, undefined);
}

export async function handleSkillsUninstall(
  params: Record<string, unknown>,
  respond: RespondFn,
): Promise<void> {
  if (typeof params.skillKey !== "string" || !params.skillKey.trim()) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "skills.uninstall requires skillKey parameter"),
    );
    return;
  }
  const skillKey = params.skillKey.trim();
  const { loadConfig } = await import("../../config/config.js");
  const cfg = loadConfig();
  const workspaceDirRaw = cfg.agent?.workspace ?? DEFAULT_AGENT_WORKSPACE_DIR;
  const workspaceDir = resolveUserPath(workspaceDirRaw);

  try {
    const report = buildWorkspaceSkillStatus(workspaceDir, { config: cfg });
    const skillEntry = report.skills.find(
      (s) => s.skillKey === skillKey || s.name === skillKey,
    );
    if (!skillEntry) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, `Skill "${skillKey}" not found`));
      return;
    }
    if (skillEntry.source === "clawdis-bundled") {
      const skills = cfg.skills ? { ...cfg.skills } : {};
      const entries = skills.entries ? { ...skills.entries } : {};
      entries[skillKey] = { ...entries[skillKey], enabled: false };
      skills.entries = entries;
      await writeConfigFile({ ...cfg, skills });
      respond(true, { ok: true, skillKey, action: "disabled" }, undefined);
      return;
    }
    const skillPath = skillEntry.baseDir;
    if (skillPath && fs.existsSync(skillPath)) {
      fs.rmSync(skillPath, { recursive: true, force: true });
    }
    const skills = cfg.skills ? { ...cfg.skills } : {};
    const entries = skills.entries ? { ...skills.entries } : {};
    delete entries[skillKey];
    skills.entries = entries;
    await writeConfigFile({ ...cfg, skills });
    respond(true, { ok: true, skillKey, action: "deleted" }, undefined);
  } catch (err) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, `Failed to uninstall skill: ${formatError(err)}`),
    );
  }
}

export async function handleSkillsClawHubInstall(
  params: Record<string, unknown>,
  respond: RespondFn,
  broadcast: BroadcastFn,
): Promise<void> {
  const slug = typeof params.slug === "string" ? params.slug.trim() : "";
  if (!slug) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "slug required"));
    return;
  }
  try {
    const skillMdUrl = `https://clawhub.ai/api/v1/skills/${encodeURIComponent(slug)}/file?path=SKILL.md`;
    const res = await fetch(skillMdUrl);
    if (!res.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, `ClawHub returned ${res.status}`));
      return;
    }
    const skillMd = await res.text();
    if (!skillMd.trim()) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Empty SKILL.md from ClawHub"));
      return;
    }
    const skillDir = path.join(CONFIG_DIR, "skills", slug);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillMd, "utf-8");
    broadcast("skills.installed", { name: slug });
    respond(true, { ok: true, name: slug }, undefined);
  } catch (err) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, `Install failed: ${formatError(err)}`));
  }
}
