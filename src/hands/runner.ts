/**
 * Hands Runner — Activate, deactivate, and manage Hand instances
 *
 * Each Hand instance:
 * - Has its own dedicated agent session
 * - May have one or more cron jobs for autonomous execution
 * - Can be paused/resumed
 * - Stores dashboard metrics in memory
 */

import crypto from "node:crypto";
import type { HandDefinition, HandInstance, HandActivationResult } from "./types.js";
import type { HandsRegistry } from "./registry.js";
import type { CronService } from "../cron/service.js";
import type { CronJobCreate } from "../cron/types.js";
import { checkRequirements } from "./requirements.js";

export interface HandsRunnerConfig {
  registry: HandsRegistry;
  cronService: CronService;
  createIsolatedAgentSession: (params: {
    sessionKey: string;
    systemPrompt?: string;
    message?: string;
  }) => Promise<{ sessionId: string }>;
  terminateSession: (sessionId: string) => Promise<void>;
  sendMessageToSession: (params: {
    sessionId: string;
    message: string;
  }) => Promise<void>;
}

export class HandsRunner {
  private readonly config: HandsRunnerConfig;

  constructor(config: HandsRunnerConfig) {
    this.config = config;
  }

  /**
   * Activate a Hand — create instance, session, and cron jobs
   */
  async activateHand(
    handId: string,
    userConfig: Record<string, string | number | boolean>,
  ): Promise<HandActivationResult> {
    const definition = this.config.registry.getDefinition(handId);
    if (!definition) {
      throw new Error(`Hand not found: ${handId}`);
    }

    // Check requirements
    const reqCheck = await checkRequirements(definition);
    const warnings: string[] = [];
    if (!reqCheck.ok) {
      throw new Error(
        `Requirements not met: missing: ${reqCheck.missing.join(", ")}`,
      );
    }
    if (reqCheck.optional.length > 0) {
      warnings.push(
        `Optional requirements not met: ${reqCheck.optional.join(", ")}`,
      );
    }

    // Build system prompt with user config substitution
    let prompt = definition.systemPrompt;
    for (const [key, value] of Object.entries(userConfig)) {
      const placeholder = `{{${key}}}`;
      prompt = prompt.replaceAll(placeholder, String(value));
    }

    // Create dedicated session
    const sessionKey = `hand:${handId}:${crypto.randomUUID().slice(0, 8)}`;
    const { sessionId } = await this.config.createIsolatedAgentSession({
      sessionKey,
      systemPrompt: prompt,
    });

    // Create cron jobs if autonomous (max_iterations set)
    const cronJobIds: string[] = [];
    if (definition.agent.max_iterations && definition.agent.max_iterations > 0) {
      const intervalMs = this.parseCheckInterval(
        userConfig.check_interval as string,
      );
      if (intervalMs) {
        const cronSpec: CronJobCreate = {
          name: `hand:${handId}`,
          description: `Autonomous run for ${definition.name}`,
          enabled: true,
          schedule: { kind: "every", everyMs: intervalMs },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: {
            kind: "agentTurn",
            message: "Continue your autonomous workflow.",
          },
          isolation: {
            postToMainPrefix: definition.name,
            maxAttempts: 3,
            retryBackoffMs: 60_000,
          },
        };
        const cronJob = await this.config.cronService.add(cronSpec);
        cronJobIds.push(cronJob.id);
      }
    }

    // Create instance
    const instance: HandInstance = {
      instanceId: crypto.randomUUID(),
      handId,
      status: "active",
      sessionId,
      config: userConfig,
      cronJobIds,
      activatedAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.config.registry.addInstance(instance);
    await this.config.registry.saveInstances();

    return { instance, warnings };
  }

  /**
   * Deactivate a Hand — stop all cron jobs and terminate session
   */
  async deactivateHand(instanceId: string): Promise<void> {
    const instance = this.config.registry.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance not found: ${instanceId}`);
    }

    // Stop all cron jobs
    for (const cronJobId of instance.cronJobIds) {
      try {
        await this.config.cronService.remove(cronJobId);
      } catch (err) {
        console.warn(`[hands] failed to remove cron job ${cronJobId}: ${err}`);
      }
    }

    // Terminate session
    try {
      await this.config.terminateSession(instance.sessionId);
    } catch (err) {
      console.warn(`[hands] failed to terminate session: ${err}`);
    }

    // Update instance status
    this.config.registry.updateInstance(instanceId, {
      status: "inactive",
      cronJobIds: [],
    });
    await this.config.registry.saveInstances();
  }

  /**
   * Pause a Hand (stop cron jobs but keep session)
   */
  async pauseHand(instanceId: string): Promise<void> {
    const instance = this.config.registry.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance not found: ${instanceId}`);
    }

    // Disable all cron jobs
    for (const cronJobId of instance.cronJobIds) {
      try {
        await this.config.cronService.update(cronJobId, { enabled: false });
      } catch (err) {
        console.warn(`[hands] failed to disable cron job ${cronJobId}: ${err}`);
      }
    }

    this.config.registry.updateInstance(instanceId, { status: "paused" });
    await this.config.registry.saveInstances();
  }

  /**
   * Resume a Hand (re-enable cron jobs)
   */
  async resumeHand(instanceId: string): Promise<void> {
    const instance = this.config.registry.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance not found: ${instanceId}`);
    }

    // Re-enable all cron jobs
    for (const cronJobId of instance.cronJobIds) {
      try {
        await this.config.cronService.update(cronJobId, { enabled: true });
      } catch (err) {
        console.warn(`[hands] failed to enable cron job ${cronJobId}: ${err}`);
      }
    }

    this.config.registry.updateInstance(instanceId, { status: "active" });
    await this.config.registry.saveInstances();
  }

  /**
   * Send a message to a Hand's session
   */
  async messageHand(
    instanceId: string,
    message: string,
  ): Promise<void> {
    const instance = this.config.registry.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance not found: ${instanceId}`);
    }

    if (instance.status !== "active" && instance.status !== "paused") {
      throw new Error(`Cannot message hand in status: ${instance.status}`);
    }

    await this.config.sendMessageToSession({
      sessionId: instance.sessionId,
      message,
    });
  }

  /**
   * Parse check interval setting to milliseconds
   */
  private parseCheckInterval(interval?: string): number | null {
    if (!interval) return 5 * 60 * 1000; // default 5 minutes

    const mapping: Record<string, number> = {
      every_1m: 60 * 1000,
      every_5m: 5 * 60 * 1000,
      every_15m: 15 * 60 * 1000,
      every_30m: 30 * 60 * 1000,
      every_1h: 60 * 60 * 1000,
    };

    return mapping[interval] ?? null;
  }
}
