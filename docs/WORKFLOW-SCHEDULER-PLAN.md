# Workflow & Scheduler — Implementation Plan

## Hiện trạng

### Openclaw đã có: Cron Scheduler ✅

Hệ thống cron **đầy đủ và hoạt động** — không cần viết lại:

| Feature | Status | Files |
|---------|--------|-------|
| CronService (start/stop/add/update/remove/run) | ✅ Working | `src/cron/service.ts` |
| 3 loại schedule: one-shot (`at`), interval (`every`), cron expression (`cron`) | ✅ Working | `src/cron/schedule.ts` |
| Persistent storage (JSON5 + JSONL run history) | ✅ Working | `src/cron/store.ts`, `src/cron/run-log.ts` |
| Isolated agent sessions (`cron:<jobId>`) | ✅ Working | `src/cron/isolated-agent.ts` |
| Gateway WS API (cron.list/add/update/remove/run/runs/status) | ✅ Working | `src/gateway/handlers/cron-handlers.ts` |
| CLI commands (`clawdis cron status/list/add/edit/run/rm`) | ✅ Working | `src/cli/cron-cli.ts` |
| Heartbeat wakeup integration | ✅ Working | `src/infra/heartbeat-wake.ts` |
| Test suite (4 files) | ✅ Passing | `src/cron/*.test.ts` |

### Openclaw chưa có ❌

| Feature | Openfang có | Openclaw |
|---------|-------------|----------|
| **Hands** (autonomous agent packages) | ✅ 7 bundled hands | ❌ Không có |
| **Workflow Engine** (multi-step pipelines) | ✅ sequential/fan-out/collect/loop | ❌ Không có |
| **Trigger Engine** (event-driven automation) | ✅ pattern matching trên kernel events | ❌ Không có |
| **Scheduler UI** (WebUI page) | ✅ Dashboard + metrics | ❌ Page `scheduler.js` có nhưng chưa kết nối |
| **Budget/Quota tracking** | ✅ Per-agent token quota (rolling 1h window) | ❌ Chỉ có usage log, không có quota enforcement |
| **Retries & Error recovery** | ✅ consecutive_errors counter, auto-disable ≥5 fails | ⚠️ Schema có `maxAttempts` nhưng chưa wire |

---

## Tham khảo Openfang

### Hands Architecture (Openfang)

```
HAND.toml manifest
  ├── id, name, description, category, icon
  ├── [[requires]]        — binary/env/api-key checks
  ├── [[settings]]        — user-configurable UI options
  ├── [agent]             — model, temperature, max_iterations, system_prompt
  └── [dashboard]         — memory-key metrics for UI
```

- **Autonomous hands**: có `max_iterations` → chạy background loop mỗi 60s
- **Reactive hands**: không có `max_iterations` → chỉ chạy khi user gửi message
- **Activation**: spawn agent + create HandInstance → persist state
- **Scheduling**: hand dùng `schedule_create` tool (gọi CronScheduler)

### Workflow Engine (Openfang)

```
WorkflowDefinition
  ├── steps: [Step]
  │   ├── Sequential      — chạy lần lượt
  │   ├── FanOut           — chạy song song
  │   ├── Collect          — fan-out + aggregate kết quả
  │   ├── Conditional      — if/then/else
  │   └── Loop             — lặp với điều kiện
  ├── variables            — {{input}}, {{step_name.output}}
  └── error_handling       — fail | skip | retry
```

### Trigger Engine (Openfang)

```
TriggerDefinition
  ├── pattern: "lifecycle" | "content_match" | "memory_update" | "all"
  ├── agent_id: UUID      — agent xử lý khi trigger fire
  └── template: string    — prompt template với {{event}}
```

---

## Implementation Plan

### Phase 1: Scheduler UI — kết nối cái đã có (1-2 ngày)

**Mục tiêu**: WebUI page `scheduler.js` hiển thị và quản lý cron jobs.

**Việc cần làm**:

1. **`ui/js/pages/scheduler.js`** — kết nối với gateway WS API:
   - `loadJobs()` → gọi `cron.list`
   - `addJob()` → gọi `cron.add` với form input
   - `editJob()` → gọi `cron.update`
   - `deleteJob()` → gọi `cron.remove`
   - `runJob()` → gọi `cron.run` (manual trigger)
   - `viewRuns()` → gọi `cron.runs` (history)
   - `getStatus()` → gọi `cron.status`

2. **UI components**:
   - Job list table: name, schedule (human-readable), next run, last status, actions
   - Add/Edit modal: name, description, schedule type selector, cron expression builder
   - Run history panel: timestamps, status, duration, error messages
   - Status bar: scheduler enabled/disabled, next wake time

3. **Real-time updates**: listen for `cron` events (added/updated/removed/started/finished)

**Files cần sửa**:
- `ui/js/pages/scheduler.js` — main page logic
- `ui/js/api.js` — thêm scheduler API wrapper functions
- `ui/index_body.html` — scheduler page template (nếu chưa có)

---

### Phase 2: Retry & Error Recovery — wire cái đã có trong schema (0.5 ngày)

**Mục tiêu**: Cron jobs tự retry khi fail, auto-disable khi fail quá nhiều.

**Việc cần làm**:

1. **`src/cron/service.ts`** — implement retry logic:
   ```typescript
   // Trong executeJob():
   if (result.status === "error" && job.runtime?.maxAttempts > 1) {
     const attempts = (job.state.consecutiveErrors ?? 0) + 1;
     if (attempts < job.runtime.maxAttempts) {
       // Schedule retry với backoff
       const backoffMs = job.runtime.retryBackoffMs ?? 60_000;
       job.state.nextRunAtMs = Date.now() + backoffMs * attempts;
       return; // don't mark as final failure
     }
   }
   // Auto-disable after N consecutive failures
   if ((job.state.consecutiveErrors ?? 0) >= 5) {
     job.enabled = false;
     console.warn(`[cron] auto-disabled job ${job.id} after 5 consecutive failures`);
   }
   ```

2. **`src/cron/types.ts`** — thêm `consecutiveErrors` vào CronJobState:
   ```typescript
   consecutiveErrors?: number;
   ```

**Files cần sửa**:
- `src/cron/service.ts` — retry loop + auto-disable
- `src/cron/types.ts` — state field

---

### Phase 3: Hands System — DevOps Edition (3-5 ngày)

**Mục tiêu**: Autonomous agent packages cho DevOps tasks.

#### 3.1 Hand Definition Format

Dùng `HAND.md` (Markdown + YAML frontmatter) thay vì TOML — consistent với skills:

```markdown
---
id: server-monitor
name: Server Monitor
description: Monitor server health, disk, memory, services
category: devops
icon: "🖥️"

requires:
  - key: ssh
    label: SSH access configured
    type: binary
    check: ssh

settings:
  - key: target_hosts
    label: Target hosts (comma-separated)
    type: text
    default: "localhost"
  - key: check_interval
    label: Check interval
    type: select
    default: "every_5m"
    options:
      - { value: "every_1m", label: "Every minute" }
      - { value: "every_5m", label: "Every 5 minutes" }
      - { value: "every_15m", label: "Every 15 minutes" }
      - { value: "every_1h", label: "Every hour" }
  - key: alert_channel
    label: Alert channel
    type: select
    default: "telegram"
    options:
      - { value: "telegram", label: "Telegram" }
      - { value: "lark", label: "Lark" }

agent:
  model: default
  temperature: 0.2
  max_iterations: 20
  timeout_seconds: 120

dashboard:
  - { label: "Hosts Monitored", memory_key: "monitor_hosts_count", format: "number" }
  - { label: "Last Check", memory_key: "monitor_last_check", format: "datetime" }
  - { label: "Alerts Sent", memory_key: "monitor_alerts_count", format: "number" }
---

# Server Monitor Hand

You are a server monitoring agent. Your job is to periodically check server health and alert the owner when issues are detected.

## Workflow

### Phase 1: Configuration
- Read target hosts from settings: {{target_hosts}}
- Set up check schedule: {{check_interval}}

### Phase 2: Health Check Loop
For each host:
1. Check SSH connectivity
2. Check disk usage (`df -h`) — alert if >85%
3. Check memory usage (`free -m`) — alert if >90%
4. Check systemd services — alert if any critical service is down
5. Check load average — alert if >80% of CPU cores

### Phase 3: Alert & Report
- Send alerts via {{alert_channel}} for critical issues
- Store metrics in memory for dashboard
- Log check results for historical tracking
```

#### 3.2 Core Implementation

**Thư mục mới**: `src/hands/`

```
src/hands/
├── types.ts              — HandDefinition, HandInstance, HandStatus, HandSetting
├── registry.ts           — HandRegistry: load bundled + user hands, CRUD instances
├── runner.ts             — activateHand, deactivateHand, pauseHand, resumeHand
├── parser.ts             — parse HAND.md (frontmatter + system prompt body)
├── requirements.ts       — checkRequirements (binary/env/api-key checks)
└── bundled/              — bundled DevOps hands
    ├── server-monitor/HAND.md
    ├── log-analyzer/HAND.md
    ├── backup-manager/HAND.md
    └── deploy-watcher/HAND.md
```

**Key types**:

```typescript
// types.ts
interface HandDefinition {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  requires: HandRequirement[];
  settings: HandSetting[];
  agent: { model: string; temperature: number; max_iterations?: number; timeout_seconds?: number };
  dashboard: HandMetric[];
  systemPrompt: string;  // parsed from markdown body
}

interface HandInstance {
  instanceId: string;
  handId: string;
  status: "active" | "paused" | "error" | "inactive";
  sessionId: string;           // agent session ID
  config: Record<string, string>;  // user settings values
  cronJobIds: string[];        // linked cron jobs
  activatedAt: number;
  updatedAt: number;
}

type HandStatus = "active" | "paused" | "error" | "inactive";
```

**Runner logic** (`runner.ts`):

```typescript
async function activateHand(handId: string, config: Record<string, string>): Promise<HandInstance> {
  const def = registry.getDefinition(handId);

  // 1. Check requirements
  const reqCheck = await checkRequirements(def.requires);
  if (!reqCheck.ok) throw new Error(`Requirements not met: ${reqCheck.missing.join(", ")}`);

  // 2. Build system prompt with user config substitution
  let prompt = def.systemPrompt;
  for (const [key, value] of Object.entries(config)) {
    prompt = prompt.replaceAll(`{{${key}}}`, value);
  }

  // 3. Create dedicated session
  const sessionId = `hand:${handId}:${crypto.randomUUID().slice(0, 8)}`;

  // 4. If autonomous (max_iterations), create cron job
  const cronJobIds: string[] = [];
  if (def.agent.max_iterations) {
    const intervalMs = parseCheckInterval(config.check_interval ?? "every_5m");
    const jobId = await cronService.add({
      name: `hand:${handId}`,
      description: `Autonomous run for ${def.name}`,
      enabled: true,
      schedule: { kind: "every", everyMs: intervalMs },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "Continue your monitoring workflow." },
    });
    cronJobIds.push(jobId);
  }

  // 5. Persist instance
  const instance: HandInstance = {
    instanceId: crypto.randomUUID(),
    handId,
    status: "active",
    sessionId,
    config,
    cronJobIds,
    activatedAt: Date.now(),
    updatedAt: Date.now(),
  };
  registry.saveInstance(instance);
  return instance;
}
```

#### 3.3 Gateway Integration

**WS API methods**:

| Method | Params | Returns |
|--------|--------|---------|
| `hands.list` | `{}` | `{ hands: HandDefinition[] }` |
| `hands.get` | `{ id }` | `HandDefinition + requirementStatus` |
| `hands.activate` | `{ id, config }` | `HandInstance` |
| `hands.deactivate` | `{ instanceId }` | `{ ok }` |
| `hands.pause` | `{ instanceId }` | `{ ok }` |
| `hands.resume` | `{ instanceId }` | `{ ok }` |
| `hands.instances` | `{}` | `{ instances: HandInstance[] }` |
| `hands.stats` | `{ instanceId }` | `{ metrics, agentStatus }` |
| `hands.updateSettings` | `{ instanceId, config }` | `HandInstance` |

**Handler file**: `src/gateway/handlers/hands-handlers.ts`

#### 3.4 WebUI — Hands Page

**`ui/js/pages/hands.js`**:
- **Marketplace view**: grid of available hands với icon, name, description, category
- **Activation modal**: settings form (generated từ `HandSetting[]`), requirements checklist
- **Active hands panel**: running instances với status, pause/resume/stop buttons
- **Dashboard view**: per-hand metrics từ memory keys

---

### Phase 4: Workflow Engine (2-3 ngày)

**Mục tiêu**: Multi-step pipelines cho DevOps automation.

#### 4.1 Workflow Definition

```typescript
// src/workflows/types.ts
interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  variables: Record<string, string>;  // default values
  onError: "fail" | "skip" | "retry";
  maxRetries: number;
  timeoutMs: number;
}

type WorkflowStep =
  | { kind: "agent"; name: string; prompt: string; model?: string; timeoutMs?: number }
  | { kind: "bash"; name: string; command: string; timeoutMs?: number }
  | { kind: "conditional"; condition: string; then: WorkflowStep[]; else?: WorkflowStep[] }
  | { kind: "parallel"; steps: WorkflowStep[] }
  | { kind: "loop"; steps: WorkflowStep[]; maxIterations: number; until?: string };

interface WorkflowRun {
  runId: string;
  workflowId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  completedAt?: number;
  stepResults: StepResult[];
  variables: Record<string, string>;
}
```

#### 4.2 Core Implementation

```
src/workflows/
├── types.ts              — WorkflowDefinition, WorkflowStep, WorkflowRun
├── engine.ts             — WorkflowEngine: execute, cancel, status
├── store.ts              — persist definitions + run history
├── executor.ts           — step executors (agent, bash, conditional, parallel, loop)
└── variables.ts          — variable substitution engine
```

**Execution model**:

```typescript
// engine.ts
class WorkflowEngine {
  async execute(workflowId: string, input: Record<string, string>): Promise<WorkflowRun> {
    const def = this.store.getDefinition(workflowId);
    const run = createRun(def, input);

    for (const step of def.steps) {
      const result = await this.executeStep(step, run.variables);
      run.stepResults.push(result);

      if (result.status === "failed") {
        if (def.onError === "fail") { run.status = "failed"; break; }
        if (def.onError === "retry" && result.attempts < def.maxRetries) {
          // retry step
        }
        // skip → continue
      }

      // Store step output as variable for next steps
      run.variables[step.name] = result.output;
    }

    return run;
  }
}
```

#### 4.3 Gateway + UI

- WS API: `workflows.list`, `workflows.create`, `workflows.run`, `workflows.cancel`, `workflows.runs`
- UI page: visual pipeline builder (drag & drop steps), run history, live execution view

---

### Phase 5: Trigger Engine (1-2 ngày)

**Mục tiêu**: Event-driven automation — react to system events.

```typescript
// src/triggers/types.ts
interface TriggerDefinition {
  id: string;
  name: string;
  enabled: boolean;
  pattern: TriggerPattern;
  action: TriggerAction;
}

type TriggerPattern =
  | { kind: "cron_finished"; jobId?: string; status?: "ok" | "error" }
  | { kind: "hand_event"; handId?: string; event?: string }
  | { kind: "content_match"; substring: string }
  | { kind: "webhook"; path: string }
  | { kind: "file_change"; glob: string };

type TriggerAction =
  | { kind: "notify"; channel: "telegram" | "lark"; message: string }
  | { kind: "run_workflow"; workflowId: string; input?: Record<string, string> }
  | { kind: "agent_message"; sessionKey: string; prompt: string }
  | { kind: "bash"; command: string };
```

```
src/triggers/
├── types.ts              — TriggerDefinition, TriggerPattern, TriggerAction
├── engine.ts             — TriggerEngine: register, evaluate, fire
└── store.ts              — persist trigger definitions
```

---

### Phase 6: Bundled DevOps Hands (2-3 ngày)

4 hands cơ bản cho DevOps:

| Hand | Category | Mô tả | Schedule |
|------|----------|--------|----------|
| `server-monitor` | monitoring | Health check: disk, memory, CPU, services | Every 5m |
| `log-analyzer` | monitoring | Parse logs, detect anomalies, alert patterns | Every 15m |
| `backup-manager` | ops | Automated backup verify + rotation | Daily 2 AM |
| `deploy-watcher` | ci/cd | Watch deploy pipelines, notify status, rollback | Event-driven |

---

## Thứ tự ưu tiên

```
Phase 1: Scheduler UI ──────────────── [ưu tiên cao, dễ làm]
Phase 2: Retry & Error Recovery ─────── [nhỏ, wire cái có sẵn]
Phase 3: Hands System ──────────────── [core feature, lớn nhất]
  └─ 3.1-3.2: types + registry + runner
  └─ 3.3: gateway handlers
  └─ 3.4: UI page
Phase 4: Workflow Engine ────────────── [phase 2 priority]
Phase 5: Trigger Engine ─────────────── [phase 2 priority]
Phase 6: Bundled Hands ──────────────── [sau khi system stable]
```

---

## So sánh kiến trúc

| Aspect | Openfang (Rust) | Openclaw (TypeScript) |
|--------|-----------------|----------------------|
| Cron scheduler | ✅ `cron.rs` | ✅ `src/cron/` (đã có) |
| Hand definitions | HAND.toml (compiled-in) | HAND.md (file-based, hot-reload) |
| Hand activation | Kernel spawns agent | CronService creates isolated session |
| Workflow | `workflow.rs` engine | `src/workflows/engine.ts` (cần build) |
| Triggers | `triggers.rs` event bus | `src/triggers/engine.ts` (cần build) |
| Budget tracking | Per-agent token quota | Usage log + quota enforcement (cần build) |
| Storage | DashMap + JSON persist | JSON5 + JSONL (consistent với cron) |
| UI | React SPA | Alpine.js pages (consistent với hiện tại) |

---

## Notes

- **Không copy 1:1 từ openfang** — lấy concept, adapt cho TypeScript + codebase hiện tại
- **Hands dùng cron infrastructure có sẵn** — không tạo scheduler mới
- **HAND.md format** thay vì TOML — consistent với SKILL.md pattern
- **File-based hands** (không compile-in) — cho phép user tạo custom hands
- **Bundled hands trong `src/hands/bundled/`** — ship cùng binary, copy vào `~/clawd/hands/` on first run
