/**
 * Workflow Engine — Multi-step pipelines for DevOps automation
 *
 * WorkflowDefinition:
 *   steps: [Step]
 *     - Sequential      — chạy lần lượt
 *     - FanOut           — chạy song song
 *     - Collect          — fan-out + aggregate kết quả
 *     - Conditional      — if/then/else
 *     - Loop             — lặp với điều kiện
 *   variables            — {{input}}, {{step_name.output}}
 *   error_handling       — fail | skip | retry
 */

import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import JSON5 from "json5";

export type WorkflowStep =
  | {
      kind: "agent";
      name: string;
      prompt: string;
      model?: string;
      timeoutMs?: number;
    }
  | { kind: "bash"; name: string; command: string; timeoutMs?: number }
  | { kind: "sleep"; name: string; durationMs: number }
  | {
      kind: "conditional";
      name: string;
      condition: string;
      then: WorkflowStep[];
      else?: WorkflowStep[];
    }
  | { kind: "parallel"; name: string; steps: WorkflowStep[] }
  | {
      kind: "loop";
      name: string;
      steps: WorkflowStep[];
      maxIterations: number;
      until?: string;
    };

export type WorkflowDefinition = {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  variables: Record<string, string>; // default values
  onError: "fail" | "skip" | "retry";
  maxRetries: number;
  timeoutMs: number;
  createdAtMs: number;
  updatedAtMs: number;
};

export type StepResult = {
  stepName: string;
  status: "running" | "completed" | "failed" | "skipped";
  output?: string;
  error?: string;
  durationMs: number;
  startedAt: number;
  completedAt?: number;
  attempts: number;
};

export type WorkflowRun = {
  runId: string;
  workflowId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  completedAt?: number;
  stepResults: StepResult[];
  variables: Record<string, string>;
  error?: string;
};

const WORKFLOWS_DIR = join(process.env.HOME ?? "", ".clawdis", "workflows");
const WORKFLOWS_FILE = join(WORKFLOWS_DIR, "workflows.json5");
const RUNS_FILE = join(WORKFLOWS_DIR, "runs.jsonl");

export interface WorkflowEngineConfig {
  workflowsDir?: string;
  workflowsFile?: string;
  runsFile?: string;
  runAgentStep: (params: {
    prompt: string;
    model?: string;
    timeoutMs?: number;
  }) => Promise<{ output: string; error?: string }>;
  runBashStep: (params: {
    command: string;
    timeoutMs?: number;
  }) => Promise<{ output: string; error?: string }>;
  emitEvent?: (event: string, payload: unknown) => void;
}

export class WorkflowEngine {
  private readonly config: Omit<WorkflowEngineConfig, "emitEvent"> & {
    emitEvent: (event: string, payload: unknown) => void;
  };
  private workflows: Map<string, WorkflowDefinition> = new Map();
  private runs: Map<string, WorkflowRun> = new Map();

  constructor(config?: WorkflowEngineConfig) {
    this.config = {
      workflowsDir: config?.workflowsDir ?? WORKFLOWS_DIR,
      workflowsFile: config?.workflowsFile ?? WORKFLOWS_FILE,
      runsFile: config?.runsFile ?? RUNS_FILE,
      runAgentStep:
        config?.runAgentStep ??
        (async () => ({ output: "", error: "Not implemented" })),
      runBashStep:
        config?.runBashStep ??
        (async () => ({ output: "", error: "Not implemented" })),
      emitEvent: config?.emitEvent ?? (() => {}),
    };
  }

  async loadWorkflows(): Promise<void> {
    this.workflows.clear();

    const workflowsFile = this.config.workflowsFile;
    if (!workflowsFile || !existsSync(workflowsFile)) {
      return;
    }

    try {
      const content = readFileSync(workflowsFile, "utf-8");
      const data = JSON5.parse(content) as { workflows?: WorkflowDefinition[] };
      if (Array.isArray(data.workflows)) {
        for (const workflow of data.workflows) {
          this.workflows.set(workflow.id, workflow);
        }
      }
    } catch (err) {
      console.warn(`[workflows] failed to load workflows: ${err}`);
    }
  }

  async saveWorkflows(): Promise<void> {
    try {
      const workflowsFile = this.config.workflowsFile;
      if (!workflowsFile) {
        throw new Error("workflowsFile is not configured");
      }
      const dir = dirname(workflowsFile);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const data = {
        version: 1,
        workflows: Array.from(this.workflows.values()),
      };
      writeFileSync(workflowsFile, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error(`[workflows] failed to save workflows: ${err}`);
      throw err;
    }
  }

  async loadRuns(): Promise<void> {
    this.runs.clear();

    const runsFile = this.config.runsFile;
    if (!runsFile || !existsSync(runsFile)) {
      return;
    }

    try {
      const content = readFileSync(runsFile, "utf-8");
      const lines = content.trim().split("\n");
      for (const line of lines) {
        if (!line) continue;
        const run = JSON5.parse(line) as WorkflowRun;
        this.runs.set(run.runId, run);
      }
    } catch (err) {
      console.warn(`[workflows] failed to load runs: ${err}`);
    }
  }

  async appendRun(run: WorkflowRun): Promise<void> {
    this.runs.set(run.runId, run);
    try {
      const runsFile = this.config.runsFile;
      if (!runsFile) {
        throw new Error("runsFile is not configured");
      }
      const dir = dirname(runsFile);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const line = `${JSON.stringify(run)}\n`;
      const { appendFileSync } = require("node:fs");
      appendFileSync(runsFile, line);
    } catch (err) {
      console.error(`[workflows] failed to append run: ${err}`);
    }
  }

  getWorkflow(id: string): WorkflowDefinition | undefined {
    return this.workflows.get(id);
  }

  listWorkflows(): WorkflowDefinition[] {
    return Array.from(this.workflows.values());
  }

  async createWorkflow(
    def: Omit<WorkflowDefinition, "id" | "createdAtMs" | "updatedAtMs">,
  ): Promise<WorkflowDefinition> {
    const id = crypto.randomUUID();
    const now = Date.now();
    const workflow: WorkflowDefinition = {
      ...def,
      id,
      createdAtMs: now,
      updatedAtMs: now,
    };
    this.workflows.set(id, workflow);
    await this.saveWorkflows();
    return workflow;
  }

  async updateWorkflow(
    id: string,
    updates: Partial<Omit<WorkflowDefinition, "id" | "createdAtMs">>,
  ): Promise<WorkflowDefinition | undefined> {
    const workflow = this.workflows.get(id);
    if (!workflow) return undefined;

    const updated: WorkflowDefinition = {
      ...workflow,
      ...updates,
      id,
      updatedAtMs: Date.now(),
    };
    this.workflows.set(id, updated);
    await this.saveWorkflows();
    return updated;
  }

  async deleteWorkflow(id: string): Promise<boolean> {
    const deleted = this.workflows.delete(id);
    if (deleted) {
      await this.saveWorkflows();
    }
    return deleted;
  }

  getRun(runId: string): WorkflowRun | undefined {
    return this.runs.get(runId);
  }

  listRuns(workflowId?: string): WorkflowRun[] {
    const all = Array.from(this.runs.values()).sort(
      (a, b) => b.startedAt - a.startedAt,
    );
    if (workflowId) {
      return all.filter((r) => r.workflowId === workflowId);
    }
    return all;
  }

  async execute(
    workflowId: string,
    input: Record<string, string> = {},
  ): Promise<WorkflowRun> {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    const runId = crypto.randomUUID();
    const run: WorkflowRun = {
      runId,
      workflowId,
      status: "running",
      startedAt: Date.now(),
      stepResults: [],
      variables: { ...workflow.variables, ...input },
    };

    await this.appendRun(run);
    this.config.emitEvent?.("workflow.started", { runId, workflowId });

    try {
      const timeout = setTimeout(() => {
        if (this.runs.get(runId)?.status === "running") {
          this.cancelRun(runId, "Workflow timeout");
        }
      }, workflow.timeoutMs);

      for (const step of workflow.steps) {
        const result = await this.executeStep(step, run, workflow);
        run.stepResults.push(result);

        if (result.status === "failed") {
          if (workflow.onError === "fail") {
            run.status = "failed";
            run.error = result.error || "Step failed";
            break;
          }
          if (
            workflow.onError === "retry" &&
            result.attempts < workflow.maxRetries
          ) {
            // Retry step
            continue;
          }
          // skip → continue
        }

        // Store step output as variable for next steps
        if (result.output) {
          run.variables[step.name] = result.output;
        }
      }

      clearTimeout(timeout);

      if (run.status === "running") {
        run.status = "completed";
      }
      run.completedAt = Date.now();
    } catch (err) {
      run.status = "failed";
      run.error = String(err);
      run.completedAt = Date.now();
    }

    await this.appendRun(run);
    this.config.emitEvent?.("workflow.finished", { runId, status: run.status });
    return run;
  }

  async cancelRun(runId: string, reason = "Cancelled"): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || run.status !== "running") {
      return;
    }

    run.status = "cancelled";
    run.error = reason;
    run.completedAt = Date.now();
    await this.appendRun(run);
    this.config.emitEvent?.("workflow.cancelled", { runId, reason });
  }

  private async executeStep(
    step: WorkflowStep,
    run: WorkflowRun,
    workflow: WorkflowDefinition,
  ): Promise<StepResult> {
    const startTime = Date.now();
    const result: StepResult = {
      stepName: step.name,
      status: "running",
      startedAt: startTime,
      durationMs: 0,
      attempts: 0,
    };

    const finish = (
      status: StepResult["status"],
      output?: string,
      error?: string,
    ) => {
      result.status = status;
      result.output = output;
      result.error = error;
      result.completedAt = Date.now();
      result.durationMs = result.completedAt - startTime;
      return result;
    };

    try {
      switch (step.kind) {
        case "agent": {
          const prompt = this.substituteVariables(step.prompt, run.variables);
          const agentResult = await this.config.runAgentStep({
            prompt,
            model: step.model,
            timeoutMs: step.timeoutMs,
          });
          if (agentResult.error) {
            return finish("failed", undefined, agentResult.error);
          }
          return finish("completed", agentResult.output);
        }

        case "bash": {
          const command = this.substituteVariables(step.command, run.variables);
          const bashResult = await this.config.runBashStep({
            command,
            timeoutMs: step.timeoutMs,
          });
          if (bashResult.error) {
            return finish("failed", undefined, bashResult.error);
          }
          return finish("completed", bashResult.output);
        }

        case "sleep": {
          await new Promise((resolve) => setTimeout(resolve, step.durationMs));
          return finish("completed", `Slept for ${step.durationMs}ms`);
        }

        case "conditional": {
          const conditionMet = this.evaluateCondition(
            step.condition,
            run.variables,
          );
          const branch = conditionMet ? step.then : step.else;
          if (!branch || branch.length === 0) {
            return finish(
              "completed",
              `Condition ${step.condition} was ${conditionMet}`,
            );
          }

          for (const branchStep of branch) {
            const branchResult = await this.executeStep(
              branchStep,
              run,
              workflow,
            );
            run.stepResults.push(branchResult);
            if (
              branchResult.status === "failed" &&
              workflow.onError === "fail"
            ) {
              return finish(
                "failed",
                undefined,
                `Branch step failed: ${branchResult.error}`,
              );
            }
          }
          return finish(
            "completed",
            `Condition ${step.condition} was ${conditionMet}`,
          );
        }

        case "parallel": {
          const promises = step.steps.map((s) =>
            this.executeStep(s, run, workflow),
          );
          const results = await Promise.all(promises);
          for (const r of results) {
            run.stepResults.push(r);
          }
          const failed = results.filter((r) => r.status === "failed");
          if (failed.length > 0 && workflow.onError === "fail") {
            return finish(
              "failed",
              undefined,
              `${failed.length} parallel steps failed`,
            );
          }
          return finish(
            "completed",
            `${results.length} parallel steps completed`,
          );
        }

        case "loop": {
          let iterations = 0;
          while (iterations < step.maxIterations) {
            iterations++;
            for (const loopStep of step.steps) {
              const loopResult = await this.executeStep(
                loopStep,
                run,
                workflow,
              );
              run.stepResults.push(loopResult);
              if (
                loopResult.status === "failed" &&
                workflow.onError === "fail"
              ) {
                return finish(
                  "failed",
                  undefined,
                  `Loop step failed: ${loopResult.error}`,
                );
              }
            }

            if (
              step.until &&
              this.evaluateCondition(step.until, run.variables)
            ) {
              break;
            }
          }
          return finish(
            "completed",
            `Loop completed after ${iterations} iterations`,
          );
        }

        default:
          return finish(
            "failed",
            undefined,
            `Unknown step kind: ${(step as { kind: string }).kind}`,
          );
      }
    } catch (err) {
      return finish("failed", undefined, String(err));
    }
  }

  private substituteVariables(
    template: string,
    variables: Record<string, string>,
  ): string {
    let result = template;
    for (const [key, value] of Object.entries(variables)) {
      const regex = new RegExp(`\\{\\{${key}\\}\\}`, "g");
      result = result.replace(regex, value);
    }
    return result;
  }

  private evaluateCondition(
    condition: string,
    variables: Record<string, string>,
  ): boolean {
    // Simple condition evaluation
    // Supports: {{var}} == "value", {{var}} != "value", {{var}} contains "text"
    const regex = /\{\{(\w+)\}\}\s*(==|!=|contains)\s*"([^"]*)"/;
    const match = condition.match(regex);
    if (!match) return false;

    const varName = match[1];
    const operator = match[1];
    const expectedValue = match[2];
    const actualValue = variables[varName] || "";

    switch (operator) {
      case "==":
        return actualValue === expectedValue;
      case "!=":
        return actualValue !== expectedValue;
      case "contains":
        return actualValue.includes(expectedValue);
      default:
        return false;
    }
  }
}

/**
 * Global workflow engine instance
 */
let globalEngine: WorkflowEngine | null = null;

export function getGlobalWorkflowEngine(): WorkflowEngine {
  if (!globalEngine) {
    globalEngine = new WorkflowEngine();
  }
  return globalEngine;
}

export async function initGlobalWorkflowEngine(
  config?: WorkflowEngineConfig,
): Promise<WorkflowEngine> {
  const engine = new WorkflowEngine(config);
  await engine.loadWorkflows();
  await engine.loadRuns();
  globalEngine = engine;
  return engine;
}
