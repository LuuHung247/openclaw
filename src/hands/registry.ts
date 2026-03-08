/**
 * Hands Registry — Store and manage Hand definitions and instances
 *
 * Hands are stored in:
 * - Bundled hands: src/hands/bundled/
 * - User hands: ~/.clawdis/hands/
 *
 * Instances are persisted in: ~/.clawdis/hands/instances.json5
 */

import crypto from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import JSON5 from "json5";
import type {
  HandDefinition,
  HandInstance,
  HandStatus,
} from "./types.js";
import { loadHandsFromDirectory } from "./parser.js";

const HANDS_DIR = join(process.env.HOME ?? "", ".clawdis", "hands");
const BUNDLED_DIR = join(
  import.meta.dirname ?? "",
  "..",
  "hands",
  "bundled",
);
const INSTANCES_FILE = join(HANDS_DIR, "instances.json5");

export interface HandsRegistryConfig {
  handsDir?: string;
  bundledDir?: string;
  instancesFile?: string;
}

export class HandsRegistry {
  private definitions: Map<string, HandDefinition> = new Map();
  private instances: Map<string, HandInstance> = new Map();
  private config: Required<HandsRegistryConfig>;

  constructor(config?: HandsRegistryConfig) {
    this.config = {
      handsDir: config?.handsDir ?? HANDS_DIR,
      bundledDir: config?.bundledDir ?? BUNDLED_DIR,
      instancesFile: config?.instancesFile ?? INSTANCES_FILE,
    };
  }

  /**
   * Load all hand definitions from bundled and user directories
   */
  async loadDefinitions(): Promise<void> {
    this.definitions.clear();

    // Load bundled hands
    if (existsSync(this.config.bundledDir)) {
      const bundled = loadHandsFromDirectory(this.config.bundledDir);
      for (const hand of bundled) {
        this.definitions.set(hand.id, hand);
      }
    }

    // Load user hands
    if (existsSync(this.config.handsDir)) {
      const user = loadHandsFromDirectory(this.config.handsDir);
      for (const hand of user) {
        this.definitions.set(hand.id, hand);
      }
    }
  }

  /**
   * Load persisted instances from disk
   */
  async loadInstances(): Promise<void> {
    this.instances.clear();

    if (!existsSync(this.config.instancesFile)) {
      return;
    }

    try {
      const content = readFileSync(this.config.instancesFile, "utf-8");
      const data = JSON5.parse(content) as { instances?: HandInstance[] };
      if (Array.isArray(data.instances)) {
        for (const instance of data.instances) {
          this.instances.set(instance.instanceId, instance);
        }
      }
    } catch (err) {
      console.warn(`[hands] failed to load instances: ${err}`);
    }
  }

  /**
   * Save instances to disk
   */
  async saveInstances(): Promise<void> {
    try {
      const dir = dirname(this.config.instancesFile);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const data = {
        version: 1,
        instances: Array.from(this.instances.values()),
      };
      writeFileSync(this.config.instancesFile, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error(`[hands] failed to save instances: ${err}`);
      throw err;
    }
  }

  /**
   * Get a hand definition by ID
   */
  getDefinition(id: string): HandDefinition | undefined {
    return this.definitions.get(id);
  }

  /**
   * List all hand definitions
   */
  listDefinitions(): HandDefinition[] {
    return Array.from(this.definitions.values());
  }

  /**
   * List hand definitions by category
   */
  listByCategory(category: string): HandDefinition[] {
    return this.listDefinitions().filter((h) => h.category === category);
  }

  /**
   * Get a hand instance by ID
   */
  getInstance(instanceId: string): HandInstance | undefined {
    return this.instances.get(instanceId);
  }

  /**
   * List all hand instances
   */
  listInstances(): HandInstance[] {
    return Array.from(this.instances.values());
  }

  /**
   * List instances by hand ID
   */
  listInstancesByHand(handId: string): HandInstance[] {
    return this.listInstances().filter((i) => i.handId === handId);
  }

  /**
   * List instances by status
   */
  listInstancesByStatus(status: HandStatus): HandInstance[] {
    return this.listInstances().filter((i) => i.status === status);
  }

  /**
   * Add a new instance
   */
  addInstance(instance: HandInstance): void {
    this.instances.set(instance.instanceId, instance);
  }

  /**
   * Update an existing instance
   */
  updateInstance(
    instanceId: string,
    updates: Partial<Omit<HandInstance, "instanceId" | "handId" | "activatedAt">>,
  ): HandInstance | undefined {
    const instance = this.instances.get(instanceId);
    if (!instance) return undefined;

    const updated: HandInstance = {
      ...instance,
      ...updates,
      updatedAt: Date.now(),
    };
    this.instances.set(instanceId, updated);
    return updated;
  }

  /**
   * Remove an instance
   */
  removeInstance(instanceId: string): boolean {
    return this.instances.delete(instanceId);
  }

  /**
   * Generate a unique instance ID
   */
  generateInstanceId(): string {
    return crypto.randomUUID();
  }
}

/**
 * Global registry instance
 */
let globalRegistry: HandsRegistry | null = null;

export function getGlobalRegistry(): HandsRegistry {
  if (!globalRegistry) {
    globalRegistry = new HandsRegistry();
  }
  return globalRegistry;
}

export async function initGlobalRegistry(
  config?: HandsRegistryConfig,
): Promise<HandsRegistry> {
  const registry = new HandsRegistry(config);
  await registry.loadDefinitions();
  await registry.loadInstances();
  globalRegistry = registry;
  return registry;
}
