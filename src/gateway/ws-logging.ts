import chalk from "chalk";

export type GatewayWsLogStyle = "auto" | "full" | "compact";

let gatewayWsLogStyle: GatewayWsLogStyle = "auto";

export function setGatewayWsLogStyle(style: GatewayWsLogStyle): void {
  gatewayWsLogStyle = style;
}

export function getGatewayWsLogStyle(): GatewayWsLogStyle {
  return gatewayWsLogStyle;
}

export const DEFAULT_WS_SLOW_MS = 50;

// ─── Shared helpers ───────────────────────────────────────────────────────────

const LOG_VALUE_LIMIT_WS = 240;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function shortId(value: string): string {
  const s = value.trim();
  if (UUID_RE.test(s)) return `${s.slice(0, 8)}…${s.slice(-4)}`;
  if (s.length <= 24) return s;
  return `${s.slice(0, 12)}…${s.slice(-4)}`;
}

export function formatForLog(value: unknown): string {
  try {
    if (value instanceof Error) {
      const parts: string[] = [];
      if (value.name) parts.push(value.name);
      if (value.message) parts.push(value.message);
      const code =
        "code" in value &&
          (typeof value.code === "string" || typeof value.code === "number")
          ? String(value.code)
          : "";
      if (code) parts.push(`code=${code}`);
      const combined = parts.filter(Boolean).join(": ").trim();
      if (combined) {
        return combined.length > LOG_VALUE_LIMIT_WS
          ? `${combined.slice(0, LOG_VALUE_LIMIT_WS)}...`
          : combined;
      }
    }
    if (value && typeof value === "object") {
      const rec = value as Record<string, unknown>;
      if (typeof rec.message === "string" && rec.message.trim()) {
        const name = typeof rec.name === "string" ? rec.name.trim() : "";
        const code =
          typeof rec.code === "string" || typeof rec.code === "number"
            ? String(rec.code)
            : "";
        const parts = [name, rec.message.trim()].filter(Boolean);
        if (code) parts.push(`code=${code}`);
        const combined = parts.join(": ").trim();
        return combined.length > LOG_VALUE_LIMIT_WS
          ? `${combined.slice(0, LOG_VALUE_LIMIT_WS)}...`
          : combined;
      }
    }
    const str =
      typeof value === "string" || typeof value === "number"
        ? String(value)
        : JSON.stringify(value);
    if (!str) return "";
    return str.length > LOG_VALUE_LIMIT_WS
      ? `${str.slice(0, LOG_VALUE_LIMIT_WS)}...`
      : str;
  } catch {
    return String(value);
  }
}

function buildRestMeta(
  meta: Record<string, unknown>,
  skipKeys: string[],
): string[] {
  const result: string[] = [];
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined) continue;
    if (skipKeys.includes(key)) continue;
    result.push(`${chalk.dim(key)}=${formatForLog(value)}`);
  }
  return result;
}

// ─── Inflight tracking maps (shared, lazily initialised) ──────────────────────

// These maps are passed in as arguments so the logging functions stay pure
// and testable without needing the GatewayContext.

export type WsLogInflightMaps = {
  since: Map<string, number>;
  compact: Map<string, { ts: number; method?: string; meta?: Record<string, unknown> }>;
  optimized: Map<string, number>;
  lastCompactConnId: { value: string | undefined };
};

// ─── Unified logWs entry point ────────────────────────────────────────────────

export function logWsWithMaps(
  maps: WsLogInflightMaps,
  direction: "in" | "out",
  kind: string,
  meta?: Record<string, unknown>,
  isVerbose?: boolean,
): void {
  const style = getGatewayWsLogStyle();
  if (!isVerbose) {
    logWsOptimizedWithMaps(maps, direction, kind, meta);
    return;
  }
  if (style === "compact" || style === "auto") {
    logWsCompactWithMaps(maps, direction, kind, meta);
    return;
  }
  logWsFullWithMaps(maps, direction, kind, meta);
}

// ─── Full (verbose) style ─────────────────────────────────────────────────────

function logWsFullWithMaps(
  maps: WsLogInflightMaps,
  direction: "in" | "out",
  kind: string,
  meta?: Record<string, unknown>,
): void {
  const now = Date.now();
  const connId = typeof meta?.connId === "string" ? meta.connId : undefined;
  const id = typeof meta?.id === "string" ? meta.id : undefined;
  const method = typeof meta?.method === "string" ? meta.method : undefined;
  const ok = typeof meta?.ok === "boolean" ? meta.ok : undefined;
  const event = typeof meta?.event === "string" ? meta.event : undefined;

  const inflightKey = connId && id ? `${connId}:${id}` : undefined;
  if (direction === "in" && kind === "req" && inflightKey) {
    maps.since.set(inflightKey, now);
  }
  const durationMs =
    direction === "out" && kind === "res" && inflightKey
      ? (() => {
        const startedAt = maps.since.get(inflightKey);
        if (startedAt === undefined) return undefined;
        maps.since.delete(inflightKey);
        return now - startedAt;
      })()
      : undefined;

  const dirArrow = direction === "in" ? "←" : "→";
  const dirColor = direction === "in" ? chalk.greenBright : chalk.cyanBright;
  const prefix = `${chalk.gray("[gws]")} ${dirColor(dirArrow)} ${chalk.bold(kind)}`;
  const headline =
    (kind === "req" || kind === "res") && method
      ? chalk.bold(method)
      : kind === "event" && event
        ? chalk.bold(event)
        : undefined;
  const statusToken =
    kind === "res" && ok !== undefined
      ? ok ? chalk.greenBright("✓") : chalk.redBright("✗")
      : undefined;
  const durationToken =
    typeof durationMs === "number" ? chalk.dim(`${durationMs}ms`) : undefined;

  const restMeta = meta
    ? buildRestMeta(meta, ["connId", "id", "method", "ok", "event"])
    : [];

  const trailing: string[] = [];
  if (connId) trailing.push(`${chalk.dim("conn")}=${chalk.gray(shortId(connId))}`);
  if (id) trailing.push(`${chalk.dim("id")}=${chalk.gray(shortId(id))}`);

  console.log(
    [prefix, statusToken, headline, durationToken, ...restMeta, ...trailing]
      .filter((t): t is string => Boolean(t))
      .join(" "),
  );
}

// ─── Optimized (quiet) style ──────────────────────────────────────────────────

function logWsOptimizedWithMaps(
  maps: WsLogInflightMaps,
  direction: "in" | "out",
  kind: string,
  meta?: Record<string, unknown>,
): void {
  const connId = typeof meta?.connId === "string" ? meta.connId : undefined;
  const id = typeof meta?.id === "string" ? meta.id : undefined;
  const ok = typeof meta?.ok === "boolean" ? meta.ok : undefined;
  const method = typeof meta?.method === "string" ? meta.method : undefined;

  const inflightKey = connId && id ? `${connId}:${id}` : undefined;

  if (direction === "in" && kind === "req" && inflightKey) {
    maps.optimized.set(inflightKey, Date.now());
    if (maps.optimized.size > 2000) maps.optimized.clear();
    return;
  }

  if (kind === "parse-error") {
    const errorMsg =
      typeof meta?.error === "string" ? formatForLog(meta.error) : undefined;
    console.log(
      [
        `${chalk.gray("[gws]")} ${chalk.redBright("✗")} ${chalk.bold("parse-error")}`,
        errorMsg ? `${chalk.dim("error")}=${errorMsg}` : undefined,
        `${chalk.dim("conn")}=${chalk.gray(shortId(connId ?? "?"))}`,
      ]
        .filter((t): t is string => Boolean(t))
        .join(" "),
    );
    return;
  }

  if (direction !== "out" || kind !== "res") return;

  const startedAt = inflightKey ? maps.optimized.get(inflightKey) : undefined;
  if (inflightKey) maps.optimized.delete(inflightKey);
  const durationMs = typeof startedAt === "number" ? Date.now() - startedAt : undefined;

  const shouldLog =
    ok === false ||
    (typeof durationMs === "number" && durationMs >= DEFAULT_WS_SLOW_MS);
  if (!shouldLog) return;

  const statusToken =
    ok === undefined ? undefined : ok ? chalk.greenBright("✓") : chalk.redBright("✗");
  const durationToken =
    typeof durationMs === "number" ? chalk.dim(`${durationMs}ms`) : undefined;

  const restMeta = meta
    ? buildRestMeta(meta, ["connId", "id", "method", "ok"])
    : [];

  console.log(
    [
      `${chalk.gray("[gws]")} ${chalk.yellowBright("⇄")} ${chalk.bold("res")}`,
      statusToken,
      method ? chalk.bold(method) : undefined,
      durationToken,
      ...restMeta,
      connId ? `${chalk.dim("conn")}=${chalk.gray(shortId(connId))}` : undefined,
      id ? `${chalk.dim("id")}=${chalk.gray(shortId(id))}` : undefined,
    ]
      .filter((t): t is string => Boolean(t))
      .join(" "),
  );
}

// ─── Compact style ────────────────────────────────────────────────────────────

function logWsCompactWithMaps(
  maps: WsLogInflightMaps,
  direction: "in" | "out",
  kind: string,
  meta?: Record<string, unknown>,
): void {
  const now = Date.now();
  const connId = typeof meta?.connId === "string" ? meta.connId : undefined;
  const id = typeof meta?.id === "string" ? meta.id : undefined;
  const method = typeof meta?.method === "string" ? meta.method : undefined;
  const ok = typeof meta?.ok === "boolean" ? meta.ok : undefined;
  const inflightKey = connId && id ? `${connId}:${id}` : undefined;

  if (kind === "req" && direction === "in" && inflightKey) {
    maps.compact.set(inflightKey, { ts: now, method, meta });
    return;
  }

  const compactArrow =
    kind === "req" || kind === "res" ? "⇄" : direction === "in" ? "←" : "→";
  const arrowColor =
    kind === "req" || kind === "res"
      ? chalk.yellowBright
      : direction === "in"
        ? chalk.greenBright
        : chalk.cyanBright;

  const prefix = `${chalk.gray("[gws]")} ${arrowColor(compactArrow)} ${chalk.bold(kind)}`;
  const statusToken =
    kind === "res" && ok !== undefined
      ? ok ? chalk.greenBright("✓") : chalk.redBright("✗")
      : undefined;

  const startedAt =
    kind === "res" && direction === "out" && inflightKey
      ? maps.compact.get(inflightKey)?.ts
      : undefined;
  if (kind === "res" && direction === "out" && inflightKey) {
    maps.compact.delete(inflightKey);
  }
  const durationToken =
    typeof startedAt === "number" ? chalk.dim(`${now - startedAt}ms`) : undefined;

  const headline =
    (kind === "req" || kind === "res") && method
      ? chalk.bold(method)
      : kind === "event" && typeof meta?.event === "string"
        ? chalk.bold(meta.event)
        : undefined;

  const restMeta = meta
    ? buildRestMeta(meta, ["connId", "id", "method", "ok", "event"])
    : [];

  const trailing: string[] = [];
  if (connId && connId !== maps.lastCompactConnId.value) {
    trailing.push(`${chalk.dim("conn")}=${chalk.gray(shortId(connId))}`);
    maps.lastCompactConnId.value = connId;
  }
  if (id) trailing.push(`${chalk.dim("id")}=${chalk.gray(shortId(id))}`);

  console.log(
    [prefix, statusToken, headline, durationToken, ...restMeta, ...trailing]
      .filter((t): t is string => Boolean(t))
      .join(" "),
  );
}
