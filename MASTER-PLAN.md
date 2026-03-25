# MASTER PLAN — OpenClaw Stabilization & Architecture

> Ưu tiên: fix bugs blocking → stable core → port từ openfang

---

## PHẦN 1 — BUG FIX (URGENT)

### BUG-1: Model switch lỗi — bare model ID không deterministic

**Root cause đã xác định:**

`sessions.json` lưu `"model": "glm-4.7"` (không có provider prefix).
Khi `agent.ts` resolve, nó loop qua `cfg.models.providers` để tìm provider cho bare model ID.
**Cả `zai` và `litellm` đều có `glm-4.7`** → thứ tự iteration object không đảm bảo → có thể pick sai provider.

Nếu pick `litellm`: dùng LiteLLM proxy (context 128k, không reasoning).
Nếu pick `zai`: dùng z.ai trực tiếp (context 204k, reasoning enabled).

**Fix — 2 điểm:**

#### FIX 1A: Normalize model khi save (sessions.patch — WS handler)

**File**: `src/gateway/server.ts` — WS handler `sessions.patch` (~line 5007)

Hiện tại WS handler **thiếu** xử lý `modelOverride` (khác với HTTP bridge handler đã có). Cần thêm:

```typescript
// Sau groupActivation block, trước store[key] = next:
if ("modelOverride" in p) {
  const raw = p.modelOverride;
  if (raw === null) {
    delete next.model;
    delete next.modelOverride;
    delete next.providerOverride;
  } else if (raw !== undefined) {
    let normalized = String(raw).trim();
    if (!normalized.includes("/")) {
      // Bare ID: lookup provider, dùng FIRST match
      const providers = cfg.models?.providers ?? {};
      for (const [provId, provCfg] of Object.entries(providers)) {
        const models = (provCfg as { models?: { id: string }[] }).models;
        if (models?.some((m) => m.id === normalized)) {
          normalized = `${provId}/${normalized}`;
          break;
        }
      }
    }
    next.model = normalized;
    delete next.modelOverride;
    delete next.providerOverride;
  }
}
```

#### FIX 1B: Xóa duplicate glm-4.7 trong config

`clawdis.json` có `zai/glm-4.7` và `litellm/glm-4.7` — cùng model ID, khác provider.
Lookup bare `"glm-4.7"` sẽ luôn mơ hồ.

**Options:**
- Đổi litellm model ID thành `"glm-4.7-litellm"` để phân biệt
- **Hoặc** luôn lưu `provider/model` (không bao giờ bare) — enforce ở cả save và UI

**Recommend**: enforce `provider/model` format ở mọi nơi. UI đã gửi `"zai/glm-4.7"`, chỉ cần WS handler không strip provider.

---

### BUG-2: Gemini turn ordering error — message thứ 2 bị reject

**Root cause đã xác định:**

pi-ai `transorm-messages.js:29-31`:
```javascript
// Same provider → pass through UNCHANGED (including thoughtSignature)
if (assistantMsg.provider === model.provider && assistantMsg.api === model.api) {
    return msg;
}
```

History messages có `provider: "google"`, model hiện tại cũng `google` → không transform → `thoughtSignature` từ session cũ vẫn được gửi cho Gemini API → Gemini reject.

**Fix — pi-embedded-runner.ts:**

Sau strip `thoughtSignature` block (line ~416), thêm:

```typescript
// Remove provider/api from assistant history messages so pi-ai's
// transformMessages() treats them as cross-provider and strips
// thinking blocks/signatures (avoids Gemini turn ordering error).
prior = prior.map((msg) => {
  const m = msg as { role?: string };
  if (m.role !== "assistant") return msg;
  const { provider: _p, api: _a, ...rest } = msg as Record<string, unknown>;
  return rest as typeof msg;
});
```

**Vị trí chính xác**: sau dòng `return stripped as typeof msg;` (line 415), trước `while (prior.length > 0 && prior[0].role !== "user")`.

---

### BUG-3: Debug log còn trong production code

**File**: `src/agents/pi-embedded-runner.ts`

Có `console.warn("[pi-runner] WARNING: thoughtSignature still present...")`
→ Xóa sau khi verify BUG-2 fix.

---

## PHẦN 2 — ARCHITECTURE DECISIONS

### QUYẾT ĐỊNH ĐÃ CHỐT (từ discussion)

| Quyết định | Lý do |
|-----------|-------|
| OpenClaw = 1 agent (không multi-agent) | Simplicity, đủ cho DevOps single-user |
| Multi-agent của openfang = công cụ vệ tinh | openfang agents giao tiếp qua channel với openclaw |
| Gateway duy nhất = WS server :18789 | Single source of truth |
| Surfaces: Telegram + Lark (có thể thêm Matrix) | Multi-channel nhưng 1 agent brain |

### ARCHITECTURE TARGET

```
┌─────────────────────────────────────────────────┐
│                  openclaw agent                   │
│  (pi-embedded-runner, 1 brain, nhiều sessions)   │
└────────┬────────────────────────────┬────────────┘
         │                            │
    ┌────▼────┐                 ┌─────▼──────┐
    │Telegram │                 │    Lark     │
    │ surface │                 │   surface   │
    └─────────┘                 └────────────┘
         │
    ┌────▼──────────────────────────────────┐
    │       openfang satellite agents        │
    │  (devops-lead, coder, analyst, ops)   │
    │  communicate via Telegram/channel      │
    └───────────────────────────────────────┘
```

**openclaw** = orchestrator, receives user intent, can delegate to openfang agents
**openfang agents** = specialized workers, report back to openclaw session

---

## PHẦN 3 — PORT TỪ OPENFANG (theo priority)

### P1 — Provider Normalization (từ openfang model_catalog.rs)

**Problem hiện tại**: duplicate model IDs across providers, no canonical resolution.

**openfang approach** (`crates/openfang-runtime/src/model_catalog.rs`):
- Mỗi model có globally unique key: `"provider:model_id"`
- Provider config có `priority` field — khi bare ID, dùng provider có priority cao nhất
- Registry hỗ trợ aliases: `"gpt-4"` → `"openai:gpt-4-turbo"`

**Port sang openclaw**:

```typescript
// src/agents/model-selection.ts — thêm priority lookup

export function resolveProviderForBareModel(
  modelId: string,
  cfg: ClawdisConfig,
): string | null {
  const providers = cfg.models?.providers ?? {};
  let bestProvider: string | null = null;
  let bestPriority = -1;
  for (const [provId, provCfg] of Object.entries(providers)) {
    const p = provCfg as { models?: { id: string }[]; priority?: number };
    if (!p.models?.some((m) => m.id === modelId)) continue;
    const priority = p.priority ?? 0;
    if (priority > bestPriority) {
      bestPriority = priority;
      bestProvider = provId;
    }
  }
  return bestProvider;
}
```

**Config thay đổi**: thêm `priority` field vào provider trong `clawdis.json`:
```json
"zai": { "priority": 10, ... },
"litellm": { "priority": 5, ... }
```

### P2 — Config Hot-Reload (từ openfang kernel.rs config_reload)

**Problem hiện tại**: đổi model trong UI → restart gateway để có effect hoàn toàn.

**openfang approach**: `config_reload.rs` watch file changes, broadcast `ConfigReloaded` event.

**Port sang openclaw** (đã có partial):
- `loadConfig()` đã reload mỗi request (không cache) ✅
- Nhưng Pi SDK model registry **có cache** (`modelCatalogPromise`) → stale sau config change
- Fix: bust cache khi `sessions.patch` detect model change (line 2271 đã có partial bust)

**File**: `src/agents/model-catalog.ts` — expose `resetModelCatalogCache()` public
**File**: `src/gateway/server.ts` — call `resetModelCatalogCache()` khi `sessions.patch` thay đổi model

### P3 — Approval System UI (từ openfang approval.rs)

openfang có hệ thống approval requests hiển thị trên dashboard.
Openclaw có `Approvals` menu item trong sidebar nhưng chưa implement.

**Port**: tạo approval queue trong gateway, agent có thể `request_approval`, user confirm qua UI.

**Files cần tạo**:
- `src/gateway/handlers/approval-handlers.ts`
- `src/gateway/approvals.ts` (queue state)
- UI: `src/gateway/ui/js/pages/approvals.js` (đã có skeleton?)

### P4 — Multi-Channel Config (openfang matrix.rs auto-accept)

openfang Matrix channel có `auto_accept_invites: bool` configurable.
openclaw Lark channel thiếu similar granular config.

**Port**:
- `clawdis.json` `lark:` section — thêm `autoAcceptGroups: boolean`
- `src/lark/` — implement configurable group accept

### P5 — KaTeX Lazy Loading (openfang katex.js)

Dashboard hiện tại load KaTeX blocking first paint.
openfang port sang lazy-load (84 LOC).

**Port**: `src/gateway/ui/js/katex.js` — copy logic lazy-load

---

## PHẦN 4 — MULTI-AGENT SATELLITE PATTERN

### Concept: openclaw + openfang satellites

User chat với openclaw qua Telegram. Khi cần task phức tạp (code review, infra plan), openclaw delegate sang openfang agent và nhận kết quả.

**Protocol options**:

#### Option A — Telegram-based (đơn giản nhất)
- openclaw có skill `delegate-to-agent`
- Skill gọi openfang REST API `:4200/hands/{agent}/run`
- openfang agent trả kết quả về qua callback webhook hoặc polling
- openclaw inject kết quả vào context

#### Option B — Direct API bridge
- openclaw gateway expose `/api/satellite/` endpoints
- openfang agents configured để POST results back
- openclaw session nhận result như tool call response

**Recommend Option A** — reuse existing openfang REST, không cần thay đổi gateway lớn.

**Skill cần tạo**: `~/.clawdis/skills/satellite/SKILL.md`
**Tool cần thêm**: `delegate_to_satellite(agent: string, task: string) → string`
**Config**: `clawdis.json` → `satellite.openfangUrl: "http://localhost:4200"`

---

## THỰC HIỆN THEO THỨ TỰ

### Sprint 1 — Fix bugs blocking (làm ngay)
1. [ ] BUG-1A: Thêm `modelOverride` vào WS `sessions.patch` handler
2. [ ] BUG-2: Strip `provider`/`api` từ assistant history trước Gemini replay
3. [ ] BUG-3: Xóa debug log
4. [ ] Build + lint verify

### Sprint 2 — Provider normalization (P1)
5. [ ] Thêm `resolveProviderForBareModel()` với priority
6. [ ] Thêm `priority` field vào provider config schema
7. [ ] Update cả 2 `sessions.patch` handlers dùng priority resolver
8. [ ] Build + lint

### Sprint 3 — Config hot-reload (P2)
9. [ ] Expose `resetModelCatalogCache()` public
10. [ ] Call khi model change detected
11. [ ] Test: đổi model → không cần restart gateway

### Sprint 4 — Satellite agent prototype (Multi-agent)
12. [ ] Tạo skill `satellite/SKILL.md`
13. [ ] Implement `delegate_to_satellite` tool
14. [ ] Test: openclaw delegate task → openfang devops-lead → result về

### Sprint 5 — Approval system (P3)
15. [ ] `approval-handlers.ts`
16. [ ] UI integration

---

## FILES CẦN SỬA (Sprint 1)

| File | Thay đổi |
|------|---------|
| `src/gateway/server.ts` | Thêm `modelOverride` block vào WS `sessions.patch` (~line 5007) |
| `src/agents/pi-embedded-runner.ts` | Thêm strip `provider`/`api` từ history + xóa debug log |

**Estimate**: ~30 LOC thay đổi, build + lint pass.
