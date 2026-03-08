/**
 * Workflow handler implementations — WebSocket API for workflow automation
 */

import type { WorkflowEngine } from "../../workflows/index.js";
import type { TriggerEngine } from "../../triggers/index.js";
import {
  ErrorCodes,
  errorShape,
} from "../protocol/index.js";

type RespondFn = (
  ok: boolean,
  payload: unknown,
  error: ReturnType<typeof errorShape> | undefined,
) => void;

type WorkflowsDeps = {
  workflowEngine: WorkflowEngine;
  triggerEngine?: TriggerEngine;
};

/**
 * List all workflow definitions
 */
export async function handleWorkflowsList(
  params: Record<string, unknown>,
  deps: WorkflowsDeps,
  respond: RespondFn,
): Promise<void> {
  const workflows = deps.workflowEngine.listWorkflows();
  respond(true, { workflows }, undefined);
}

/**
 * Get a workflow definition
 */
export async function handleWorkflowsGet(
  params: Record<string, unknown>,
  deps: WorkflowsDeps,
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

  const workflow = deps.workflowEngine.getWorkflow(id);
  if (!workflow) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `Workflow not found: ${id}`),
    );
    return;
  }

  respond(true, { workflow }, undefined);
}

/**
 * Create a new workflow
 */
export async function handleWorkflowsCreate(
  params: Record<string, unknown>,
  deps: WorkflowsDeps,
  respond: RespondFn,
): Promise<void> {
  const workflow = typeof params.workflow === "object" && params.workflow !== null
    ? params.workflow as Record<string, unknown>
    : undefined;

  if (!workflow) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Missing required parameter: workflow",
      ),
    );
    return;
  }

  try {
    const created = await deps.workflowEngine.createWorkflow({
      name: String(workflow.name ?? ""),
      description: String(workflow.description ?? ""),
      steps: (workflow.steps as never[]),
      variables: (workflow.variables as Record<string, string>) ?? {},
      onError: (workflow.onError as "fail" | "skip" | "retry") ?? "fail",
      maxRetries: (workflow.maxRetries as number) ?? 3,
      timeoutMs: (workflow.timeoutMs as number) ?? 300000,
    });
    respond(true, { workflow: created }, undefined);
  } catch (err) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, String(err)),
    );
  }
}

/**
 * Update a workflow
 */
export async function handleWorkflowsUpdate(
  params: Record<string, unknown>,
  deps: WorkflowsDeps,
  respond: RespondFn,
): Promise<void> {
  const id = typeof params.id === "string" ? params.id : undefined;
  const updates = typeof params.updates === "object" && params.updates !== null
    ? params.updates as Record<string, unknown>
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
    const updated = await deps.workflowEngine.updateWorkflow(id, updates);
    if (!updated) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `Workflow not found: ${id}`),
      );
      return;
    }
    respond(true, { workflow: updated }, undefined);
  } catch (err) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, String(err)),
    );
  }
}

/**
 * Delete a workflow
 */
export async function handleWorkflowsDelete(
  params: Record<string, unknown>,
  deps: WorkflowsDeps,
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
    const deleted = await deps.workflowEngine.deleteWorkflow(id);
    respond(true, { deleted }, undefined);
  } catch (err) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, String(err)),
    );
  }
}

/**
 * Execute a workflow
 */
export async function handleWorkflowsRun(
  params: Record<string, unknown>,
  deps: WorkflowsDeps,
  respond: RespondFn,
): Promise<void> {
  const id = typeof params.id === "string" ? params.id : undefined;
  const input = typeof params.input === "object" && params.input !== null
    ? (params.input as Record<string, string>)
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
    const run = await deps.workflowEngine.execute(id, input);
    respond(true, { run }, undefined);
  } catch (err) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, String(err)),
    );
  }
}

/**
 * Cancel a workflow run
 */
export async function handleWorkflowsCancel(
  params: Record<string, unknown>,
  deps: WorkflowsDeps,
  respond: RespondFn,
): Promise<void> {
  const runId = typeof params.runId === "string" ? params.runId : undefined;
  if (!runId) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "Missing required parameter: runId"),
    );
    return;
  }

  try {
    await deps.workflowEngine.cancelRun(runId);
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
 * Get workflow runs
 */
export async function handleWorkflowsRuns(
  params: Record<string, unknown>,
  deps: WorkflowsDeps,
  respond: RespondFn,
): Promise<void> {
  const workflowId = typeof params.workflowId === "string" ? params.workflowId : undefined;
  const limit = typeof params.limit === "number" ? params.limit : 50;

  try {
    const runs = deps.workflowEngine.listRuns(workflowId).slice(0, limit);
    respond(true, { runs }, undefined);
  } catch (err) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, String(err)),
    );
  }
}
