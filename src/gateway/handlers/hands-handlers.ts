/**
 * Hands handler implementations — WebSocket API for autonomous agent packages
 *
 * Each function follows the handler extraction pattern:
 * - Validate params
 * - Call business logic
 * - Respond with result or error
 */

import type { HandsRegistry, HandsRunner } from "../../hands/index.js";
import type { HandRequirementCheck } from "../../hands/types.js";
import { checkRequirements } from "../../hands/requirements.js";
import type { CronService } from "../../cron/service.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
} from "../protocol/index.js";

type RespondFn = (
  ok: boolean,
  payload: unknown,
  error: ReturnType<typeof errorShape> | undefined,
) => void;

type HandsDeps = {
  registry: HandsRegistry;
  runner: HandsRunner;
  cronService: CronService;
};

/**
 * List all available hand definitions
 */
export async function handleHandsList(
  params: Record<string, unknown>,
  deps: HandsDeps,
  respond: RespondFn,
): Promise<void> {
  const hands = deps.registry.listDefinitions();
  respond(true, { hands }, undefined);
}

/**
 * Get a hand definition with requirement check status
 */
export async function handleHandsGet(
  params: Record<string, unknown>,
  deps: HandsDeps,
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

  const definition = deps.registry.getDefinition(id);
  if (!definition) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `Hand not found: ${id}`),
    );
    return;
  }

  // Check requirements
  let requirementStatus: HandRequirementCheck;
  try {
    requirementStatus = await checkRequirements(definition);
  } catch (err) {
    requirementStatus = {
      ok: false,
      met: [],
      missing: [`Failed to check requirements: ${String(err)}`],
      optional: [],
    };
  }

  respond(
    true,
    {
      hand: definition,
      requirements: requirementStatus,
    },
    undefined,
  );
}

/**
 * Activate a hand with user configuration
 */
export async function handleHandsActivate(
  params: Record<string, unknown>,
  deps: HandsDeps,
  respond: RespondFn,
): Promise<void> {
  const id = typeof params.id === "string" ? params.id : undefined;
  const config =
    typeof params.config === "object" && params.config !== null
      ? (params.config as Record<string, string | number | boolean>)
      : undefined;

  if (!id) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "Missing required parameter: id"),
    );
    return;
  }

  if (!config) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Missing required parameter: config",
      ),
    );
    return;
  }

  try {
    const result = await deps.runner.activateHand(id, config);
    respond(
      true,
      {
        instance: result.instance,
        warnings: result.warnings,
      },
      undefined,
    );
  } catch (err) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, String(err)),
    );
  }
}

/**
 * Deactivate a hand instance
 */
export async function handleHandsDeactivate(
  params: Record<string, unknown>,
  deps: HandsDeps,
  respond: RespondFn,
): Promise<void> {
  const instanceId =
    typeof params.instanceId === "string" ? params.instanceId : undefined;
  if (!instanceId) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Missing required parameter: instanceId",
      ),
    );
    return;
  }

  try {
    await deps.runner.deactivateHand(instanceId);
    respond(true, { ok: true }, undefined);
  } catch (err) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, String(err)),
    );
  }
}

/**
 * Pause a hand instance (stop cron jobs, keep session)
 */
export async function handleHandsPause(
  params: Record<string, unknown>,
  deps: HandsDeps,
  respond: RespondFn,
): Promise<void> {
  const instanceId =
    typeof params.instanceId === "string" ? params.instanceId : undefined;
  if (!instanceId) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Missing required parameter: instanceId",
      ),
    );
    return;
  }

  try {
    await deps.runner.pauseHand(instanceId);
    respond(true, { ok: true }, undefined);
  } catch (err) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, String(err)),
    );
  }
}

/**
 * Resume a paused hand instance
 */
export async function handleHandsResume(
  params: Record<string, unknown>,
  deps: HandsDeps,
  respond: RespondFn,
): Promise<void> {
  const instanceId =
    typeof params.instanceId === "string" ? params.instanceId : undefined;
  if (!instanceId) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Missing required parameter: instanceId",
      ),
    );
    return;
  }

  try {
    await deps.runner.resumeHand(instanceId);
    respond(true, { ok: true }, undefined);
  } catch (err) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, String(err)),
    );
  }
}

/**
 * List all hand instances
 */
export async function handleHandsInstances(
  params: Record<string, unknown>,
  deps: HandsDeps,
  respond: RespondFn,
): Promise<void> {
  const instances = deps.registry.listInstances();
  respond(true, { instances }, undefined);
}

/**
 * Get instance stats and metrics
 */
export async function handleHandsStats(
  params: Record<string, unknown>,
  deps: HandsDeps,
  respond: RespondFn,
): Promise<void> {
  const instanceId =
    typeof params.instanceId === "string" ? params.instanceId : undefined;
  if (!instanceId) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Missing required parameter: instanceId",
      ),
    );
    return;
  }

  const instance = deps.registry.getInstance(instanceId);
  if (!instance) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `Instance not found: ${instanceId}`),
    );
    return;
  }

  const definition = deps.registry.getDefinition(instance.handId);
  if (!definition) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `Hand not found: ${instance.handId}`),
    );
    return;
  }

  // TODO: Fetch actual metrics from memory/agent session
  // For now, return instance info
  respond(
    true,
    {
      instance,
      hand: definition,
      metrics: {}, // TODO: Populate from memory
    },
    undefined,
  );
}

/**
 * Update instance settings
 */
export async function handleHandsUpdateSettings(
  params: Record<string, unknown>,
  deps: HandsDeps,
  respond: RespondFn,
): Promise<void> {
  const instanceId =
    typeof params.instanceId === "string" ? params.instanceId : undefined;
  const config =
    typeof params.config === "object" && params.config !== null
      ? (params.config as Record<string, string | number | boolean>)
      : undefined;

  if (!instanceId) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Missing required parameter: instanceId",
      ),
    );
    return;
  }

  if (!config) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Missing required parameter: config",
      ),
    );
    return;
  }

  const updated = deps.registry.updateInstance(instanceId, { config });
  if (!updated) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `Instance not found: ${instanceId}`),
    );
    return;
  }

  await deps.registry.saveInstances();
  respond(true, { instance: updated }, undefined);
}
