import fs from "node:fs/promises";
import os from "node:os";

import type { AgentMessage, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import {
  buildSystemPrompt,
  createAgentSession,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { ThinkLevel, VerboseLevel } from "../auto-reply/thinking.js";
import { formatToolAggregate } from "../auto-reply/tool-meta.js";
import type { ClawdisConfig } from "../config/config.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import { splitMediaFromOutput } from "../media/parse.js";
import { getMemorySubstrate } from "../memory/sqlite.js";
import {
  type enqueueCommand,
  enqueueCommandInLane,
} from "../process/command-queue.js";
import { resolveUserPath } from "../utils.js";
import { resolveClawdisAgentDir } from "./agent-paths.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import { ensureClawdisModelsJson } from "./models-config.js";
import {
  buildBootstrapContextFiles,
  ensureSessionHeader,
  formatAssistantErrorText,
  sanitizeSessionMessagesImages,
} from "./pi-embedded-helpers.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";
import { extractAssistantText } from "./pi-embedded-utils.js";
import {
  getApiKeyForModel,
  resolveModel,
  resolvePromptSkills,
} from "./pi-model-resolver.js";
import { createClawdisCodingTools } from "./pi-tools.js";
import {
  applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot,
  buildWorkspaceSkillSnapshot,
  loadWorkspaceSkillEntries,
  type SkillSnapshot,
} from "./skills.js";
import { buildAgentSystemPromptAppend } from "./system-prompt.js";
import { loadWorkspaceBootstrapFiles } from "./workspace.js";

export type EmbeddedPiAgentMeta = {
  sessionId: string;
  provider: string;
  model: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
};

export type EmbeddedPiRunMeta = {
  durationMs: number;
  agentMeta?: EmbeddedPiAgentMeta;
  aborted?: boolean;
};

export type EmbeddedPiRunResult = {
  payloads?: Array<{
    text?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    replyToId?: string;
  }>;
  meta: EmbeddedPiRunMeta;
};

type EmbeddedPiQueueHandle = {
  queueMessage: (text: string) => Promise<void>;
  isStreaming: () => boolean;
  abort: () => void;
};

const ACTIVE_EMBEDDED_RUNS = new Map<string, EmbeddedPiQueueHandle>();

function resolveSessionLane(key: string) {
  const cleaned = key.trim() || "main";
  return cleaned.startsWith("session:") ? cleaned : `session:${cleaned}`;
}

function resolveGlobalLane(lane?: string) {
  const cleaned = lane?.trim();
  return cleaned ? cleaned : "main";
}

function mapThinkingLevel(level?: ThinkLevel): ThinkingLevel {
  if (!level) return "off";
  return level;
}

export function queueEmbeddedPiMessage(
  sessionId: string,
  text: string,
): boolean {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) return false;
  if (!handle.isStreaming()) return false;
  void handle.queueMessage(text);
  return true;
}

export function abortEmbeddedPiRun(sessionId: string): boolean {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) return false;
  handle.abort();
  return true;
}

export function isEmbeddedPiRunActive(sessionId: string): boolean {
  return ACTIVE_EMBEDDED_RUNS.has(sessionId);
}

export function isEmbeddedPiRunStreaming(sessionId: string): boolean {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) return false;
  return handle.isStreaming();
}

export function resolveEmbeddedSessionLane(key: string) {
  return resolveSessionLane(key);
}

export async function runEmbeddedPiAgent(params: {
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  workspaceDir: string;
  config?: ClawdisConfig;
  skillsSnapshot?: SkillSnapshot;
  prompt: string;
  provider?: string;
  model?: string;
  thinkLevel?: ThinkLevel;
  verboseLevel?: VerboseLevel;
  timeoutMs: number;
  runId: string;
  abortSignal?: AbortSignal;
  shouldEmitToolResult?: () => boolean;
  onPartialReply?: (payload: {
    text?: string;
    mediaUrls?: string[];
  }) => void | Promise<void>;
  onBlockReply?: (payload: {
    text?: string;
    mediaUrls?: string[];
  }) => void | Promise<void>;
  blockReplyBreak?: "text_end" | "message_end";
  onToolResult?: (payload: {
    text?: string;
    mediaUrls?: string[];
  }) => void | Promise<void>;
  onAgentEvent?: (evt: {
    stream: string;
    data: Record<string, unknown>;
  }) => void;
  lane?: string;
  enqueue?: typeof enqueueCommand;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  enforceFinalTag?: boolean;
}): Promise<EmbeddedPiRunResult> {
  const sessionLane = resolveSessionLane(
    params.sessionKey?.trim() || params.sessionId,
  );
  const globalLane = resolveGlobalLane(params.lane);
  const enqueueGlobal =
    params.enqueue ??
    ((task, opts) => enqueueCommandInLane(globalLane, task, opts));
  return enqueueCommandInLane(sessionLane, () =>
    enqueueGlobal(async () => {
      const started = Date.now();
      const resolvedWorkspace = resolveUserPath(params.workspaceDir);
      const prevCwd = process.cwd();

      const provider =
        (params.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
      const modelId = (params.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
      await ensureClawdisModelsJson(params.config);
      const agentDir = resolveClawdisAgentDir();
      const { model, error, authStorage, modelRegistry } = resolveModel(
        provider,
        modelId,
        agentDir,
        params.config,
      );
      if (!model) {
        throw new Error(error ?? `Unknown model: ${provider}/${modelId}`);
      }
      const apiKey = await getApiKeyForModel(model, authStorage);
      authStorage.setRuntimeApiKey(model.provider, apiKey);

      const thinkingLevel = mapThinkingLevel(params.thinkLevel);

      await fs.mkdir(resolvedWorkspace, { recursive: true });
      await ensureSessionHeader({
        sessionFile: params.sessionFile,
        sessionId: params.sessionId,
        cwd: resolvedWorkspace,
      });

      let restoreSkillEnv: (() => void) | undefined;
      process.chdir(resolvedWorkspace);
      try {
        const shouldLoadSkillEntries =
          !params.skillsSnapshot || !params.skillsSnapshot.resolvedSkills;
        const skillEntries = shouldLoadSkillEntries
          ? loadWorkspaceSkillEntries(resolvedWorkspace)
          : [];
        const skillsSnapshot =
          params.skillsSnapshot ??
          buildWorkspaceSkillSnapshot(resolvedWorkspace, {
            config: params.config,
            entries: skillEntries,
          });
        restoreSkillEnv = params.skillsSnapshot
          ? applySkillEnvOverridesFromSnapshot({
              snapshot: params.skillsSnapshot,
              config: params.config,
            })
          : applySkillEnvOverrides({
              skills: skillEntries ?? [],
              config: params.config,
            });

        const bootstrapFiles =
          await loadWorkspaceBootstrapFiles(resolvedWorkspace);
        const contextFiles = buildBootstrapContextFiles(bootstrapFiles);

        // Inject contextual SQLite memory (hybrid BM25 + vector when prompt available)
        try {
          const geminiKey = (
            params.config?.models?.providers?.gemini as
              | { apiKey?: string }
              | undefined
          )?.apiKey?.trim();
          const memorySubstrate = getMemorySubstrate(
            resolvedWorkspace,
            geminiKey,
          );
          const memories = params.prompt
            ? await memorySubstrate.recallHybrid(
                params.prompt,
                params.sessionId,
                10,
              )
            : memorySubstrate.recent(params.sessionId, 10);
          if (memories.length > 0) {
            const memoryContent = [...memories]
              .reverse()
              .map((m) => `[${m.created_at}] ${m.source}:\n${m.content}`)
              .join("\n\n---\n\n");
            contextFiles.push({
              path: "_memory.md",
              content: `Relevant memories for this session:\n\n${memoryContent}`,
            });
          }
        } catch {
          // ignore memory read errors
        }

        const promptSkills = resolvePromptSkills(skillsSnapshot, skillEntries);
        const tools = createClawdisCodingTools({
          bash: params.config?.agent?.bash,
          disabledTools: params.config?.agent?.disabledTools,
          workspace: resolvedWorkspace,
        });
        const machineName = await getMachineDisplayName();
        const runtimeInfo = {
          host: machineName,
          os: `${os.type()} ${os.release()}`,
          arch: os.arch(),
          node: process.version,
          model: `${provider}/${modelId}`,
        };
        // Enable reasoning tag hint for all non-Anthropic providers so the model
        // wraps internal reasoning in <think> and user-facing reply in <final>.
        const reasoningTagHint = provider !== "anthropic";
        const systemPrompt = buildSystemPrompt({
          appendPrompt: buildAgentSystemPromptAppend({
            workspaceDir: resolvedWorkspace,
            defaultThinkLevel: params.thinkLevel,
            extraSystemPrompt: params.extraSystemPrompt,
            ownerNumbers: params.ownerNumbers,
            reasoningTagHint,
            activeTools: tools.map((t) => t.name),
            runtimeInfo,
          }),
          contextFiles,
          skills: promptSkills,
          cwd: resolvedWorkspace,
          tools,
        });

        const sessionManager = SessionManager.open(params.sessionFile);
        const settingsManager = SettingsManager.create(
          resolvedWorkspace,
          agentDir,
        );

        const { session } = await createAgentSession({
          cwd: resolvedWorkspace,
          agentDir,
          authStorage,
          modelRegistry,
          model,
          thinkingLevel,
          systemPrompt,
          tools,
          sessionManager,
          settingsManager,
          skills: promptSkills,
          contextFiles,
        });

        let prior = await sanitizeSessionMessagesImages(
          session.messages,
          "session:history",
        );

        // --- Context Pruning Middleware ---
        const keepLastTurns =
          params.config?.agent?.contextPruning?.keepLastTurns;
        if (typeof keepLastTurns === "number" && keepLastTurns > 0) {
          const userIndices: number[] = [];
          for (let i = 0; i < prior.length; i++) {
            if ((prior[i] as { role?: string }).role === "user") {
              userIndices.push(i);
            }
          }
          if (userIndices.length > keepLastTurns) {
            const cutOff = userIndices[userIndices.length - keepLastTurns];
            prior = prior.slice(cutOff);
          }
        }
        // Sanitize: remove all broken assistant messages (empty content or stopReason=error)
        // anywhere in history — failed/aborted runs persist these and corrupt turn ordering
        // for providers that validate message structure (Gemini, Claude, etc).
        prior = prior.filter((msg) => {
          const m = msg as {
            role?: string;
            stopReason?: string;
            content?: unknown[];
          };
          if (
            m.role === "assistant" &&
            (!m.content?.length || m.stopReason === "error")
          ) {
            return false;
          }
          return true;
        });
        // Sanitize: strip thoughtSignature from toolCall blocks AND remove empty
        // text blocks from assistant messages that also contain tool calls.
        // Gemini thinking signatures are only valid within the same turn — replaying them
        // in a resumed session causes "function call turn comes immediately after user turn".
        // Empty text blocks alongside tool calls also confuse Gemini's turn validation.
        // Fix mirrors openfang/gemini.rs: skip thinking blocks on history replay.
        prior = prior.map((msg) => {
          const m = msg as { role?: string; content?: unknown[] };
          if (m.role !== "assistant" || !m.content?.length) return msg;
          let needsUpdate = false;
          // Check for thoughtSignature
          if (
            m.content.some(
              (b) => (b as { thoughtSignature?: unknown }).thoughtSignature,
            )
          ) {
            needsUpdate = true;
          }
          // Check for empty text blocks alongside tool calls
          const hasToolCall = m.content.some(
            (b) => (b as { type?: string }).type === "toolCall",
          );
          const hasEmptyText = m.content.some((b) => {
            const block = b as { type?: string; text?: string };
            return block.type === "text" && (!block.text || !block.text.trim());
          });
          if (hasToolCall && hasEmptyText) needsUpdate = true;

          if (!needsUpdate) return msg;

          const stripped = {
            ...m,
            content: m.content
              .map((b) => {
                const block = b as Record<string, unknown>;
                if (!block.thoughtSignature) return b;
                const { thoughtSignature: _sig, ...rest } = block;
                return rest;
              })
              .filter((b) => {
                // Remove empty text blocks from messages that have tool calls
                if (!hasToolCall) return true;
                const block = b as { type?: string; text?: string };
                if (
                  block.type === "text" &&
                  (!block.text || !block.text.trim())
                )
                  return false;
                return true;
              }),
          };
          // Cast back — we only removed extra fields, structure is still compatible
          return stripped as typeof msg;
        });
        // Force cross-provider transform: remove provider/api from assistant history
        // messages so pi-ai transformMessages() strips thinking blocks and signatures
        // instead of passing them through unchanged (same-provider shortcut in
        // transorm-messages.js:29-31). Prevents Gemini turn ordering error on replay.
        prior = prior.map((msg) => {
          const m = msg as { role?: string };
          if (m.role !== "assistant") return msg;
          const rec = msg as unknown as Record<string, unknown>;
          const { provider: _p, api: _a, ...rest } = rec;
          return rest as unknown as typeof msg;
        });
        // Sanitize: history must start with a user turn. Drop any leading non-user messages
        // (orphaned toolResult/assistant after pruning or broken serialization).
        while (
          prior.length > 0 &&
          (prior[0] as { role?: string }).role !== "user"
        ) {
          prior = prior.slice(1);
        }
        // ----------------------------------

        if (prior.length > 0) {
          session.agent.replaceMessages(prior);
        }
        let aborted = Boolean(params.abortSignal?.aborted);
        const abortRun = () => {
          aborted = true;
          void session.abort();
        };
        const queueHandle: EmbeddedPiQueueHandle = {
          queueMessage: async (text: string) => {
            await session.queueMessage(text);
          },
          isStreaming: () => session.isStreaming,
          abort: abortRun,
        };
        ACTIVE_EMBEDDED_RUNS.set(params.sessionId, queueHandle);

        const {
          assistantTexts,
          toolMetas,
          unsubscribe,
          flush: flushToolDebouncer,
          waitForCompactionRetry,
        } = subscribeEmbeddedPiSession({
          session,
          runId: params.runId,
          verboseLevel: params.verboseLevel,
          shouldEmitToolResult: params.shouldEmitToolResult,
          onToolResult: params.onToolResult,
          onBlockReply: params.onBlockReply,
          blockReplyBreak: params.blockReplyBreak,
          onPartialReply: params.onPartialReply,
          onAgentEvent: params.onAgentEvent,
          // Enable final-tag extraction whenever the system prompt uses the
          // <think>/<final> format (i.e. for all non-Anthropic providers).
          // Without this, the raw tags leak through to the user.
          enforceFinalTag: params.enforceFinalTag ?? reasoningTagHint,
        });

        const abortTimer = setTimeout(
          () => {
            abortRun();
          },
          Math.max(1, params.timeoutMs),
        );

        let messagesSnapshot: AgentMessage[] = [];
        let sessionIdUsed = session.sessionId;
        const onAbort = () => {
          abortRun();
        };
        if (params.abortSignal) {
          if (params.abortSignal.aborted) {
            onAbort();
          } else {
            params.abortSignal.addEventListener("abort", onAbort, {
              once: true,
            });
          }
        }
        let promptError: unknown = null;
        try {
          try {
            await session.prompt(params.prompt);
          } catch (err) {
            promptError = err;
          }
          await waitForCompactionRetry();
          messagesSnapshot = session.messages.slice();
          sessionIdUsed = session.sessionId;
        } finally {
          clearTimeout(abortTimer);
          unsubscribe();
          flushToolDebouncer();
          if (ACTIVE_EMBEDDED_RUNS.get(params.sessionId) === queueHandle) {
            ACTIVE_EMBEDDED_RUNS.delete(params.sessionId);
          }
          session.dispose();
          params.abortSignal?.removeEventListener?.("abort", onAbort);
        }
        if (promptError && !aborted) {
          throw promptError;
        }

        const lastAssistant = messagesSnapshot
          .slice()
          .reverse()
          .find((m) => (m as AgentMessage)?.role === "assistant") as
          | AssistantMessage
          | undefined;

        const usage = lastAssistant?.usage;
        const agentMeta: EmbeddedPiAgentMeta = {
          sessionId: sessionIdUsed,
          provider: lastAssistant?.provider ?? provider,
          model: lastAssistant?.model ?? model.id,
          usage: usage
            ? {
                input: usage.input,
                output: usage.output,
                cacheRead: usage.cacheRead,
                cacheWrite: usage.cacheWrite,
                total: usage.totalTokens,
              }
            : undefined,
        };

        const replyItems: Array<{ text: string; media?: string[] }> = [];

        const errorText = lastAssistant
          ? formatAssistantErrorText(lastAssistant)
          : undefined;
        if (errorText) replyItems.push({ text: errorText });

        const inlineToolResults =
          params.verboseLevel === "on" &&
          !params.onPartialReply &&
          !params.onToolResult &&
          toolMetas.length > 0;
        if (inlineToolResults) {
          for (const { toolName, meta } of toolMetas) {
            const agg = formatToolAggregate(toolName, meta ? [meta] : []);
            const { text: cleanedText, mediaUrls } = splitMediaFromOutput(agg);
            if (cleanedText)
              replyItems.push({ text: cleanedText, media: mediaUrls });
          }
        }

        for (const text of assistantTexts.length
          ? assistantTexts
          : lastAssistant
            ? [extractAssistantText(lastAssistant)]
            : []) {
          const { text: cleanedText, mediaUrls } = splitMediaFromOutput(text);
          if (!cleanedText && (!mediaUrls || mediaUrls.length === 0)) continue;
          replyItems.push({ text: cleanedText, media: mediaUrls });
        }

        const payloads = replyItems
          .map((item) => ({
            text: item.text?.trim() ? item.text.trim() : undefined,
            mediaUrls: item.media?.length ? item.media : undefined,
            mediaUrl: item.media?.[0],
          }))
          .filter(
            (p) =>
              p.text || p.mediaUrl || (p.mediaUrls && p.mediaUrls.length > 0),
          );

        // Persist memory for this run
        try {
          const geminiKey = (
            params.config?.models?.providers?.gemini as
              | { apiKey?: string }
              | undefined
          )?.apiKey?.trim();
          const memorySubstrate = getMemorySubstrate(
            resolvedWorkspace,
            geminiKey,
          );
          if (params.prompt) {
            memorySubstrate.store({
              agent_id: params.sessionId,
              content: params.prompt,
              source: `session:${params.sessionId}`,
              scope: "episodic",
            });
          }
          for (const p of payloads) {
            if (p.text) {
              memorySubstrate.store({
                agent_id: params.sessionId,
                content: p.text,
                source: `session:${params.sessionId}`,
                scope: "episodic",
              });
            }
          }
          if (usage) {
            memorySubstrate.logUsage({
              agent_id: params.sessionId,
              provider: agentMeta.provider || "unknown",
              model: agentMeta.model || "unknown",
              usage: {
                input: usage.input || 0,
                output: usage.output || 0,
                cacheRead: usage.cacheRead || 0,
                cacheWrite: usage.cacheWrite || 0,
                total: usage.totalTokens || 0,
              },
              durationMs: Date.now() - started,
            });
          }
        } catch (e) {
          console.error("Failed to store memory:", e);
        }

        return {
          payloads: payloads.length ? payloads : undefined,
          meta: {
            durationMs: Date.now() - started,
            agentMeta,
            aborted,
          },
        };
      } finally {
        restoreSkillEnv?.();
        process.chdir(prevCwd);
      }
    }),
  );
}
