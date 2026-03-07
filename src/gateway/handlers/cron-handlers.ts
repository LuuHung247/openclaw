/**
 * Cron handler implementations — extracted from the server.ts WS switch.
 *
 * Each function receives the CronService, storePath, and validated params,
 * and returns a plain result object that the caller can pass to respond().
 */

import {
  appendCronRunLog,
  readCronRunLogEntries,
  resolveCronRunLogPath,
} from "../../cron/run-log.js";
import type { CronService } from "../../cron/service.js";
import type { CronJobCreate, CronJobPatch } from "../../cron/types.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateCronAddParams,
  validateCronListParams,
  validateCronRemoveParams,
  validateCronRunParams,
  validateCronRunsParams,
  validateCronStatusParams,
  validateCronUpdateParams,
} from "../protocol/index.js";

type RespondFn = (
  ok: boolean,
  payload: unknown,
  error: ReturnType<typeof errorShape> | undefined,
) => void;

export async function handleCronList(
  params: Record<string, unknown>,
  cron: CronService,
  respond: RespondFn,
): Promise<void> {
  if (!validateCronListParams(params)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid cron.list params: ${formatValidationErrors(validateCronListParams.errors)}`,
      ),
    );
    return;
  }
  const p = params as { includeDisabled?: boolean };
  const jobs = await cron.list({ includeDisabled: p.includeDisabled });
  respond(true, { jobs }, undefined);
}

export async function handleCronStatus(
  params: Record<string, unknown>,
  cron: CronService,
  respond: RespondFn,
): Promise<void> {
  if (!validateCronStatusParams(params)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid cron.status params: ${formatValidationErrors(validateCronStatusParams.errors)}`,
      ),
    );
    return;
  }
  const status = await cron.status();
  respond(true, status, undefined);
}

export async function handleCronAdd(
  params: Record<string, unknown>,
  cron: CronService,
  respond: RespondFn,
): Promise<void> {
  if (!validateCronAddParams(params)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid cron.add params: ${formatValidationErrors(validateCronAddParams.errors)}`,
      ),
    );
    return;
  }
  const job = await cron.add(params as unknown as CronJobCreate);
  respond(true, job, undefined);
}

export async function handleCronUpdate(
  params: Record<string, unknown>,
  cron: CronService,
  respond: RespondFn,
): Promise<void> {
  if (!validateCronUpdateParams(params)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid cron.update params: ${formatValidationErrors(validateCronUpdateParams.errors)}`,
      ),
    );
    return;
  }
  const p = params as { id: string; patch: Record<string, unknown> };
  const job = await cron.update(p.id, p.patch as unknown as CronJobPatch);
  respond(true, job, undefined);
}

export async function handleCronRemove(
  params: Record<string, unknown>,
  cron: CronService,
  respond: RespondFn,
): Promise<void> {
  if (!validateCronRemoveParams(params)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid cron.remove params: ${formatValidationErrors(validateCronRemoveParams.errors)}`,
      ),
    );
    return;
  }
  const p = params as { id: string };
  const result = await cron.remove(p.id);
  respond(true, result, undefined);
}

export async function handleCronRun(
  params: Record<string, unknown>,
  cron: CronService,
  respond: RespondFn,
): Promise<void> {
  if (!validateCronRunParams(params)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid cron.run params: ${formatValidationErrors(validateCronRunParams.errors)}`,
      ),
    );
    return;
  }
  const p = params as { id: string; mode?: "due" | "force" };
  const result = await cron.run(p.id, p.mode);
  respond(true, result, undefined);
}

export async function handleCronRuns(
  params: Record<string, unknown>,
  cronStorePath: string,
  respond: RespondFn,
): Promise<void> {
  if (!validateCronRunsParams(params)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid cron.runs params: ${formatValidationErrors(validateCronRunsParams.errors)}`,
      ),
    );
    return;
  }
  const p = params as { id: string; limit?: number };
  const logPath = resolveCronRunLogPath({ storePath: cronStorePath, jobId: p.id });
  const entries = await readCronRunLogEntries(logPath, {
    limit: p.limit,
    jobId: p.id,
  });
  respond(true, { entries }, undefined);
}
