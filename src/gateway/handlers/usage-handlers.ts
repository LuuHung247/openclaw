/**
 * Usage analytics handler implementations — extracted from server.ts WS switch.
 */

import { readUsageLog } from "../usage-log.js";
import type { errorShape } from "../protocol/index.js";

type RespondFn = (
  ok: boolean,
  payload: unknown,
  error: ReturnType<typeof errorShape> | undefined,
) => void;

export function handleUsageSummary(respond: RespondFn): void {
  const log = readUsageLog();
  let totalIn = 0;
  let totalOut = 0;
  let totalCost = 0;
  let totalTools = 0;
  for (const e of log) {
    totalIn += e.input_tokens;
    totalOut += e.output_tokens;
    totalCost += e.cost_usd;
    totalTools += e.tool_calls;
  }
  respond(
    true,
    {
      total_input_tokens: totalIn,
      total_output_tokens: totalOut,
      total_cost_usd: totalCost,
      call_count: log.length,
      total_tool_calls: totalTools,
    },
    undefined,
  );
}

export function handleUsageByModel(respond: RespondFn): void {
  const log = readUsageLog();
  const byModel: Record<
    string,
    {
      total_input_tokens: number;
      total_output_tokens: number;
      total_cost_usd: number;
      call_count: number;
    }
  > = {};
  for (const e of log) {
    if (!byModel[e.model]) {
      byModel[e.model] = {
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost_usd: 0,
        call_count: 0,
      };
    }
    byModel[e.model].total_input_tokens += e.input_tokens;
    byModel[e.model].total_output_tokens += e.output_tokens;
    byModel[e.model].total_cost_usd += e.cost_usd;
    byModel[e.model].call_count += 1;
  }
  const models = Object.entries(byModel)
    .map(([model, stats]) => ({ model, ...stats }))
    .sort((a, b) => b.total_cost_usd - a.total_cost_usd);
  respond(true, { models }, undefined);
}

export function handleUsageByAgent(respond: RespondFn): void {
  const log = readUsageLog();
  const byAgent: Record<
    string,
    {
      total_tokens: number;
      cost_usd: number;
      tool_calls: number;
      model: string;
      call_count: number;
    }
  > = {};
  for (const e of log) {
    if (!byAgent[e.sessionKey]) {
      byAgent[e.sessionKey] = {
        total_tokens: 0,
        cost_usd: 0,
        tool_calls: 0,
        model: e.model,
        call_count: 0,
      };
    }
    byAgent[e.sessionKey].total_tokens += e.input_tokens + e.output_tokens;
    byAgent[e.sessionKey].cost_usd += e.cost_usd;
    byAgent[e.sessionKey].tool_calls += e.tool_calls;
    byAgent[e.sessionKey].call_count += 1;
    if (e.model && e.model !== "unknown") {
      byAgent[e.sessionKey].model = e.model;
    }
  }
  const agents = Object.entries(byAgent).map(([agent_id, stats]) => ({
    agent_id,
    agent_name: agent_id,
    ...stats,
  }));
  respond(true, { agents }, undefined);
}

export function handleUsageDaily(respond: RespondFn): void {
  const log = readUsageLog();
  const byDay: Record<string, { cost_usd: number; tokens: number; calls: number }> = {};
  for (const e of log) {
    if (!byDay[e.date]) byDay[e.date] = { cost_usd: 0, tokens: 0, calls: 0 };
    byDay[e.date].cost_usd += e.cost_usd;
    byDay[e.date].tokens += e.input_tokens + e.output_tokens;
    byDay[e.date].calls += 1;
  }
  const today = new Date().toISOString().slice(0, 10);
  const days = Object.entries(byDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, stats]) => ({ date, ...stats }));
  const firstEventDate = days.length > 0 ? days[0].date : null;
  respond(
    true,
    {
      days,
      today_cost_usd: byDay[today]?.cost_usd ?? 0,
      first_event_date: firstEventDate,
    },
    undefined,
  );
}
