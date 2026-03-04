export type UsageLike = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
  // Some agents/logs emit alternate naming.
  totalTokens?: number;
  total_tokens?: number;
  cache_read?: number;
  cache_write?: number;
};

const asFiniteNumber = (value: unknown): number | undefined => {
  if (typeof value !== "number") return undefined;
  if (!Number.isFinite(value)) return undefined;
  return value;
};

export function normalizeUsage(raw?: UsageLike | null):
  | {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      total?: number;
    }
  | undefined {
  if (!raw) return undefined;

  const input = asFiniteNumber(raw.input);
  const output = asFiniteNumber(raw.output);
  const cacheRead = asFiniteNumber(raw.cacheRead ?? raw.cache_read);
  const cacheWrite = asFiniteNumber(raw.cacheWrite ?? raw.cache_write);
  const total = asFiniteNumber(
    raw.total ?? raw.totalTokens ?? raw.total_tokens,
  );

  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    total === undefined
  ) {
    return undefined;
  }

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total,
  };
}

/**
 * Estimate cost in USD from token usage.
 * Priority: model config cost fields → name-based lookup → default fallback.
 * Rates are per million tokens (same convention as openfang metering).
 */
export function estimateCostUsd(
  model: string,
  usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
  configCost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
): number {
  let inputPerM: number;
  let outputPerM: number;

  if (configCost && (configCost.input !== undefined || configCost.output !== undefined)) {
    inputPerM = configCost.input ?? 0;
    outputPerM = configCost.output ?? 0;
  } else {
    [inputPerM, outputPerM] = estimateCostRates(model.toLowerCase());
  }

  const inputTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  const outputTokens = usage.output ?? 0;
  return (inputTokens / 1_000_000) * inputPerM + (outputTokens / 1_000_000) * outputPerM;
}

function estimateCostRates(model: string): [number, number] {
  if (model.includes("haiku")) return [0.25, 1.25];
  if (model.includes("opus-4-6") || model.includes("claude-opus-4-6")) return [5.0, 25.0];
  if (model.includes("opus")) return [15.0, 75.0];
  if (model.includes("sonnet")) return [3.0, 15.0];
  if (model.includes("gpt-4o-mini")) return [0.15, 0.60];
  if (model.includes("gpt-4o")) return [2.50, 10.0];
  if (model.includes("gpt-4.1-nano")) return [0.10, 0.40];
  if (model.includes("gpt-4.1-mini")) return [0.40, 1.60];
  if (model.includes("gpt-4.1")) return [2.00, 8.00];
  if (model.includes("gpt-5-nano")) return [0.05, 0.40];
  if (model.includes("gpt-5-mini")) return [0.25, 2.0];
  if (model.includes("gpt-5")) return [1.25, 10.0];
  if (model.includes("o3-mini") || model.includes("o4-mini")) return [1.10, 4.40];
  if (model.includes("gemini-2.5-flash-lite")) return [0.04, 0.15];
  if (model.includes("gemini-2.5-pro")) return [1.25, 10.0];
  if (model.includes("gemini-2.5-flash")) return [0.15, 0.60];
  if (model.includes("gemini-2.0-flash") || model.includes("gemini-flash")) return [0.10, 0.40];
  if (model.includes("gemini")) return [0.15, 0.60];
  if (model.includes("deepseek-reasoner") || model.includes("deepseek-r1")) return [0.55, 2.19];
  if (model.includes("deepseek")) return [0.27, 1.10];
  if (model.includes("llama-4-maverick")) return [0.50, 0.77];
  if (model.includes("llama-4-scout")) return [0.11, 0.34];
  if (model.includes("llama") || model.includes("mixtral")) return [0.05, 0.10];
  if (model.includes("qwen-max")) return [4.00, 12.00];
  if (model.includes("qwen-plus")) return [0.80, 2.00];
  if (model.includes("qwen")) return [0.20, 0.60];
  if (model.includes("glm-4-flash") || model.includes("glm-4.7-flash")) return [0.10, 0.10];
  if (model.includes("glm")) return [1.50, 5.00];
  if (model.includes("mistral-large")) return [2.00, 6.00];
  if (model.includes("mistral")) return [0.10, 0.30];
  if (model.includes("grok-4-1")) return [0.20, 0.50];
  if (model.includes("grok-4") || model.includes("grok-3")) return [3.0, 15.0];
  if (model.includes("grok")) return [2.0, 10.0];
  if (model.includes("command-r-plus")) return [2.50, 10.0];
  if (model.includes("command-r")) return [0.15, 0.60];
  return [1.0, 3.0]; // default fallback
}

export function derivePromptTokens(usage?: {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
}): number | undefined {
  if (!usage) return undefined;
  const input = usage.input ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const sum = input + cacheRead + cacheWrite;
  return sum > 0 ? sum : undefined;
}
