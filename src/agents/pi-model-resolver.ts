/**
 * Model and auth resolution helpers for the embedded Pi agent.
 *
 * Covers: provider/model lookup, API key retrieval, and skill-to-prompt mapping.
 */

import {
  type Api,
  getEnvApiKey,
  getOAuthApiKey,
  type Model,
  type OAuthProvider,
} from "@mariozechner/pi-ai";
import {
  discoverAuthStorage,
  discoverModels,
  type Skill,
} from "@mariozechner/pi-coding-agent";

import type { ClawdisConfig } from "../config/config.js";
import {
  ensureOAuthStorage,
  loadOAuthStorageAt,
  resolveClawdisOAuthPath,
  saveOAuthStorageAt,
} from "./pi-oauth-storage.js";
import type { SkillEntry, SkillSnapshot } from "./skills.js";

// Map from our canonical provider IDs (config/UI) to Pi SDK's internal IDs.
// Must stay in sync with the same map in model-catalog.ts.
const PROVIDER_TO_PISDK: Record<string, string> = {
  gemini: "google",
};

function isOAuthProvider(provider: string): provider is OAuthProvider {
  return (
    provider === "anthropic" ||
    provider === "github-copilot" ||
    provider === "google-gemini-cli" ||
    provider === "google-antigravity"
  );
}

export function resolveModel(
  provider: string,
  modelId: string,
  agentDir?: string,
  cfg?: ClawdisConfig,
): {
  model?: Model<Api>;
  error?: string;
  authStorage: ReturnType<typeof discoverAuthStorage>;
  modelRegistry: ReturnType<typeof discoverModels>;
} {
  const authStorage = discoverAuthStorage(agentDir);

  // Bridge API keys for built-in providers that differ between our IDs and Pi SDK IDs.
  const cfgProviders = cfg?.models?.providers ?? {};
  for (const [ourId, sdkId] of Object.entries(PROVIDER_TO_PISDK)) {
    const key = (
      cfgProviders[ourId] as { apiKey?: string } | undefined
    )?.apiKey?.trim();
    if (key) {
      authStorage.set(sdkId, { type: "api_key", key });
    }
  }

  // Translate our provider ID to Pi SDK's internal ID before lookup.
  const sdkProvider = PROVIDER_TO_PISDK[provider] ?? provider;
  const modelRegistry = discoverModels(authStorage, agentDir);
  const model = modelRegistry.find(sdkProvider, modelId) as Model<Api> | null;
  if (!model) {
    return {
      error: `Unknown model: ${provider}/${modelId}`,
      authStorage,
      modelRegistry,
    };
  }
  return { model, authStorage, modelRegistry };
}

export async function getApiKeyForModel(
  model: Model<Api>,
  authStorage: ReturnType<typeof discoverAuthStorage>,
): Promise<string> {
  const storedKey = await authStorage.getApiKey(model.provider);
  if (storedKey) return storedKey;
  ensureOAuthStorage();
  if (model.provider === "anthropic") {
    const oauthEnv = process.env.ANTHROPIC_OAUTH_TOKEN;
    if (oauthEnv?.trim()) return oauthEnv.trim();
  }
  const envKey = getEnvApiKey(model.provider);
  if (envKey) return envKey;
  if (isOAuthProvider(model.provider)) {
    const oauthPath = resolveClawdisOAuthPath();
    const storage = loadOAuthStorageAt(oauthPath);
    if (storage) {
      try {
        const result = await getOAuthApiKey(model.provider, storage);
        if (result?.apiKey) {
          storage[model.provider] = result.newCredentials;
          saveOAuthStorageAt(oauthPath, storage);
          return result.apiKey;
        }
      } catch {
        // fall through to error below
      }
    }
  }
  throw new Error(`No API key found for provider "${model.provider}"`);
}

export function resolvePromptSkills(
  snapshot: SkillSnapshot,
  entries: SkillEntry[],
): Skill[] {
  if (snapshot.resolvedSkills?.length) {
    return snapshot.resolvedSkills;
  }

  const snapshotNames = snapshot.skills.map((entry) => entry.name);
  if (snapshotNames.length === 0) return [];

  const entryByName = new Map(
    entries.map((entry) => [entry.skill.name, entry.skill]),
  );
  return snapshotNames
    .map((name) => entryByName.get(name))
    .filter((skill): skill is Skill => Boolean(skill));
}
