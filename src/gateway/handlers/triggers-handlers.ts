/**
 * Trigger handler implementations — WebSocket API for event-driven automation
 */

import type { TriggerEngine } from "../../triggers/index.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

type RespondFn = (
  ok: boolean,
  payload: unknown,
  error: ReturnType<typeof errorShape> | undefined,
) => void;

type TriggersDeps = {
  triggerEngine: TriggerEngine;
};

/**
 * List all trigger definitions
 */
export async function handleTriggersList(
  params: Record<string, unknown>,
  deps: TriggersDeps,
  respond: RespondFn,
): Promise<void> {
  const includeDisabled = params.includeDisabled === true;
  const triggers = deps.triggerEngine.listTriggers(includeDisabled);
  respond(true, { triggers }, undefined);
}

/**
 * Get a trigger definition
 */
export async function handleTriggersGet(
  params: Record<string, unknown>,
  deps: TriggersDeps,
  respond: RespondFn,
): Promise<void> {
  const id = typeof params.id === "string" ? params.id : undefined;
  if (!id) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "Missing required parameter: id"),
    );
    return;
  }

  const trigger = deps.triggerEngine.getTrigger(id);
  if (!trigger) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `Trigger not found: ${id}`),
    );
    return;
  }

  respond(true, { trigger }, undefined);
}

/**
 * Create a new trigger
 */
export async function handleTriggersCreate(
  params: Record<string, unknown>,
  deps: TriggersDeps,
  respond: RespondFn,
): Promise<void> {
  const trigger =
    typeof params.trigger === "object" && params.trigger !== null
      ? (params.trigger as Record<string, unknown>)
      : undefined;

  if (!trigger) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Missing required parameter: trigger",
      ),
    );
    return;
  }

  try {
    const created = await deps.triggerEngine.createTrigger({
      name: String(trigger.name ?? ""),
      description: String(trigger.description ?? ""),
      enabled: trigger.enabled !== false,
      pattern: trigger.pattern as never,
      action: trigger.action as never,
      cooldownMs:
        typeof trigger.cooldownMs === "number" ? trigger.cooldownMs : undefined,
    });
    respond(true, { trigger: created }, undefined);
  } catch (err) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
  }
}

/**
 * Update a trigger
 */
export async function handleTriggersUpdate(
  params: Record<string, unknown>,
  deps: TriggersDeps,
  respond: RespondFn,
): Promise<void> {
  const id = typeof params.id === "string" ? params.id : undefined;
  const updates =
    typeof params.updates === "object" && params.updates !== null
      ? (params.updates as Record<string, unknown>)
      : undefined;

  if (!id) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "Missing required parameter: id"),
    );
    return;
  }

  if (!updates) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Missing required parameter: updates",
      ),
    );
    return;
  }

  try {
    const updated = await deps.triggerEngine.updateTrigger(id, updates);
    if (!updated) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `Trigger not found: ${id}`),
      );
      return;
    }
    respond(true, { trigger: updated }, undefined);
  } catch (err) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
  }
}

/**
 * Delete a trigger
 */
export async function handleTriggersDelete(
  params: Record<string, unknown>,
  deps: TriggersDeps,
  respond: RespondFn,
): Promise<void> {
  const id = typeof params.id === "string" ? params.id : undefined;
  if (!id) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "Missing required parameter: id"),
    );
    return;
  }

  try {
    const deleted = await deps.triggerEngine.deleteTrigger(id);
    respond(true, { deleted }, undefined);
  } catch (err) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
  }
}

/**
 * Manually fire a trigger
 */
export async function handleTriggersFire(
  params: Record<string, unknown>,
  deps: TriggersDeps,
  respond: RespondFn,
): Promise<void> {
  const id = typeof params.id === "string" ? params.id : undefined;
  const eventData =
    typeof params.eventData === "object" && params.eventData !== null
      ? (params.eventData as Record<string, unknown>)
      : {};

  if (!id) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "Missing required parameter: id"),
    );
    return;
  }

  try {
    const fire = await deps.triggerEngine.fireTrigger(id, eventData);
    if (!fire) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `Trigger not found or not fired: ${id}`,
        ),
      );
      return;
    }
    respond(true, { fire }, undefined);
  } catch (err) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
  }
}

/**
 * Get trigger fires
 */
export async function handleTriggersFires(
  params: Record<string, unknown>,
  deps: TriggersDeps,
  respond: RespondFn,
): Promise<void> {
  const triggerId =
    typeof params.triggerId === "string" ? params.triggerId : undefined;
  const limit = typeof params.limit === "number" ? params.limit : 100;

  try {
    const fires = deps.triggerEngine.listFires(triggerId, limit);
    respond(true, { fires }, undefined);
  } catch (err) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
  }
}
