import { type ClawdisConfig, loadConfig } from "../config/config.js";
import { resolveClawdisAgentDir } from "./agent-paths.js";
import { ensureClawdisModelsJson } from "./models-config.js";

export type ModelCatalogEntry = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
};

type DiscoveredModel = {
  id: string;
  name?: string;
  provider: string;
  contextWindow?: number;
};

let modelCatalogPromise: Promise<ModelCatalogEntry[]> | null = null;

export function resetModelCatalogCacheForTest() {
  modelCatalogPromise = null;
}

export async function loadModelCatalog(params?: {
  config?: ClawdisConfig;
  useCache?: boolean;
}): Promise<ModelCatalogEntry[]> {
  if (params?.useCache === false) {
    modelCatalogPromise = null;
  }
  if (modelCatalogPromise) return modelCatalogPromise;

  // Mapping between our canonical provider IDs (used in config/UI) and Pi SDK's internal IDs.
  // Pi SDK built-in providers have their own naming; add entries here when they diverge.
  // Format: { ourId: piSdkId }
  const PROVIDER_ALIASES: Record<string, string> = {
    gemini: "google",
  };
  // Reverse map for normalizing Pi SDK IDs back to ours after discovery.
  const PISDK_TO_OURS: Record<string, string> = Object.fromEntries(
    Object.entries(PROVIDER_ALIASES).map(([ours, sdk]) => [sdk, ours]),
  );

  modelCatalogPromise = (async () => {
    const piSdk = await import("@mariozechner/pi-coding-agent");

    const models: ModelCatalogEntry[] = [];
    try {
      const cfg = params?.config ?? loadConfig();
      await ensureClawdisModelsJson(cfg);
      const agentDir = resolveClawdisAgentDir();
      const authStorage = piSdk.discoverAuthStorage(agentDir);

      // Bridge API keys from config into Pi SDK's authStorage for built-in providers
      // that don't use models.json (no models[] array in config).
      const cfgProviders = cfg.models?.providers ?? {};
      for (const [ourId, sdkId] of Object.entries(PROVIDER_ALIASES)) {
        const key = (cfgProviders[ourId] as { apiKey?: string } | undefined)?.apiKey?.trim();
        if (key) {
          authStorage.set(sdkId, { type: "api_key", key });
        }
      }

      const registry = piSdk.discoverModels(authStorage, agentDir) as
        | {
            getAll: () => Array<DiscoveredModel>;
          }
        | Array<DiscoveredModel>;
      const entries = Array.isArray(registry) ? registry : registry.getAll();
      for (const entry of entries) {
        const id = String(entry?.id ?? "").trim();
        if (!id) continue;
        const rawProvider = String(entry?.provider ?? "").trim();
        if (!rawProvider) continue;
        const provider = PISDK_TO_OURS[rawProvider] ?? rawProvider;
        const name = String(entry?.name ?? id).trim() || id;
        const contextWindow =
          typeof entry?.contextWindow === "number" && entry.contextWindow > 0
            ? entry.contextWindow
            : undefined;
        models.push({ id, name, provider, contextWindow });
      }
    } catch {
      // Leave models empty on discovery errors.
    }

    return models.sort((a, b) => {
      const p = a.provider.localeCompare(b.provider);
      if (p !== 0) return p;
      return a.name.localeCompare(b.name);
    });
  })();

  return modelCatalogPromise;
}
