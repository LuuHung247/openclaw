/**
 * Shared types for Gateway handler functions.
 *
 * Each handler is a pure async function that receives a HandlerContext
 * (containing parsed params + gateway state) and returns a HandlerResult.
 */

import type { GatewayContext } from "../gateway-context.js";
import type { ErrorShape } from "../protocol/index.js";

// ─── Handler result ───────────────────────────────────────────────────────────

export type HandlerResult =
  | { ok: true; payloadJSON: string }
  | { ok: false; error: ErrorShape };

// ─── Handler context passed to each handler ───────────────────────────────────

export type HandlerContext = {
  /** Parsed request params (already validated by caller if needed). */
  params: unknown;
  /** Raw params accessor (for handlers that do their own validation). */
  parseParams: () => unknown;
  /** The gateway mutable state. */
  ctx: GatewayContext;
  /** Client connection ID. */
  connId: string;
};

// ─── Handler function type ────────────────────────────────────────────────────

export type HandlerFn = (hctx: HandlerContext) => Promise<HandlerResult>;

// ─── Handler registry ─────────────────────────────────────────────────────────

export type HandlerRegistry = Record<string, HandlerFn>;
