# MODEL-FIX-PLAN — Thống nhất model resolution cho openclaw

**Ngày tạo:** 2026-03-12
**Dựa trên:** Deep audit 4 agent (agent.ts, server.ts, reply.ts, codebase-wide)

---

## Bản đồ vấn đề

### 2 flow gọi agent runtime (quan trọng!)

```
Flow A — WebUI/CLI:
  server.ts chat.send → agentCommand() (agent.ts) → runEmbeddedPiAgent()

Flow B — Telegram/auto-reply:
  reply.ts getReply() → runEmbeddedPiAgent() (trực tiếp)
```

Mỗi flow có model resolution **RIÊNG BIỆT**. Cả 2 cần fix.

### 3 nơi lưu model (chỉ nên có 1)

| Nơi | Field | Format | Status |
|-----|-------|--------|--------|
| `sessionEntry.model` | **MỚI** | `"provider/model"` | ✅ Đã được ghi bởi sessions.patch, reply.ts directive, agent run completion |
| `sessionEntry.modelOverride` | **DEPRECATED** | `"model"` (bare) | ❌ Vẫn được ĐỌC bởi agent.ts, reply.ts session load |
| `sessionEntry.providerOverride` | **DEPRECATED** | `"provider"` | ❌ Vẫn được ĐỌC bởi agent.ts, reply.ts session load |

### Root causes (theo mức độ nghiêm trọng)

| # | Bug | Nơi | Impact |
|---|-----|-----|--------|
| **A** | `agentCommand()` hoàn toàn bỏ qua `sessionEntry.model` — chỉ đọc deprecated fields | `agent.ts:260-310` | **WebUI gửi message luôn dùng config default thay vì session model** |
| **B** | `reply.ts` session load (line 892-912) copy deprecated fields vào sessionEntry mới, bỏ qua `model` field | `reply.ts:892-912` | Telegram session có thể mất model khi tạo sessionEntry mới |
| **C** | `server.ts` HTTP handler `sessions.patch` (line 4908) không xử lý model | `server.ts:4908-5020` | HTTP API path không switch model được |
| **D** | `server.ts` WS handler vẫn ghi `providerOverride` riêng (line 2497-2502) | `server.ts:2497-2502` | Có thể tạo state không nhất quán |
| **E** | Tests assert deprecated fields | `reply.directive.test.ts:594-627` | Tests pass nhưng verify sai behavior |

---

## Kế hoạch fix — 6 steps

### STEP 1: Fix `agentCommand()` — đọc `sessionEntry.model` ★ CRITICAL

**File:** `src/commands/agent.ts`
**Lines:** 260-310

**Vấn đề:** Toàn bộ model resolution dùng `sessionEntry.modelOverride` / `sessionEntry.providerOverride`. Không bao giờ đọc `sessionEntry.model`. Khi user đổi model qua UI (ghi vào `entry.model`), `agentCommand()` không thấy → fallback về config default.

**Sửa:** Thay block lines 268-310 bằng logic mới:

```typescript
// --- REPLACE lines 268-310 ---

// Resolve stored model: model field (new) > legacy override > config default
const storedModel =
  sessionEntry?.model?.trim() ||
  (sessionEntry?.providerOverride && sessionEntry?.modelOverride
    ? `${sessionEntry.providerOverride}/${sessionEntry.modelOverride}`
    : sessionEntry?.modelOverride?.trim());

const hasAllowlist = (agentCfg?.allowedModels?.length ?? 0) > 0;
const hasStoredModel = Boolean(storedModel);
const needsModelCatalog = hasAllowlist || hasStoredModel;
let allowedModelKeys = new Set<string>();

if (needsModelCatalog) {
  const catalog = await loadModelCatalog({ config: cfg });
  const allowed = buildAllowedModelSet({
    cfg,
    catalog,
    defaultProvider,
  });
  allowedModelKeys = allowed.allowedKeys;
}

if (storedModel) {
  const parts = storedModel.split("/");
  if (parts.length >= 2) {
    // Format: "provider/model"
    const candidateProvider = parts[0];
    const candidateModel = parts.slice(1).join("/");
    const key = modelKey(candidateProvider, candidateModel);
    if (allowedModelKeys.size === 0 || allowedModelKeys.has(key)) {
      provider = candidateProvider;
      model = candidateModel;
    } else if (sessionEntry && sessionStore && sessionKey) {
      // Invalid against allowlist — clear stored model
      delete sessionEntry.model;
      delete sessionEntry.modelOverride;
      delete sessionEntry.providerOverride;
      sessionEntry.updatedAt = Date.now();
      sessionStore[sessionKey] = sessionEntry;
      await saveSessionStore(storePath, sessionStore);
    }
  } else {
    // Bare model ID — lookup provider from config
    const providers = cfg.models?.providers ?? {};
    let resolvedProvider = defaultProvider;
    for (const [provId, provCfg] of Object.entries(providers)) {
      const models = (provCfg as { models?: { id: string }[] }).models;
      if (models?.some((m: { id: string }) => m.id === storedModel)) {
        resolvedProvider = provId;
        break;
      }
    }
    const key = modelKey(resolvedProvider, storedModel);
    if (allowedModelKeys.size === 0 || allowedModelKeys.has(key)) {
      provider = resolvedProvider;
      model = storedModel;
      // Normalize: save with provider prefix
      if (sessionEntry && sessionStore && sessionKey) {
        sessionEntry.model = `${resolvedProvider}/${storedModel}`;
        delete sessionEntry.modelOverride;
        delete sessionEntry.providerOverride;
        sessionEntry.updatedAt = Date.now();
        sessionStore[sessionKey] = sessionEntry;
        await saveSessionStore(storePath, sessionStore);
      }
    } else if (sessionEntry && sessionStore && sessionKey) {
      delete sessionEntry.model;
      delete sessionEntry.modelOverride;
      delete sessionEntry.providerOverride;
      sessionEntry.updatedAt = Date.now();
      sessionStore[sessionKey] = sessionEntry;
      await saveSessionStore(storePath, sessionStore);
    }
  }
}

// --- END REPLACE ---
```

**Verify:** `provider` và `model` được pass đúng tại line 336-337 (call `runEmbeddedPiAgent()`).

**Lưu ý:** Line 409 (`model: modelUsed`) đã ghi `sessionEntry.model` sau agent run — giữ nguyên, đã đúng.

---

### STEP 2: Fix `reply.ts` session load — đọc `model` field

**File:** `src/auto-reply/reply.ts`
**Lines:** 886-912

**Vấn đề:** Khi load session (line 892-893), code đọc `entry.modelOverride` và `entry.providerOverride` vào biến tạm, rồi ghi lại vào sessionEntry mới (line 911-912). Hoàn toàn bỏ qua `entry.model`.

**Sửa:**

```typescript
// --- Lines 886-919: REPLACE phần session load ---

if (!isNewSession && freshEntry) {
  sessionId = entry.sessionId;
  systemSent = entry.systemSent ?? false;
  abortedLastRun = entry.abortedLastRun ?? false;
  persistedThinking = entry.thinkingLevel;
  persistedVerbose = entry.verboseLevel;
  // NOTE: model is now in entry.model (format: "provider/model")
  // Legacy modelOverride/providerOverride are read below for backward compat
} else {
  sessionId = crypto.randomUUID();
  isNewSession = true;
  systemSent = false;
  abortedLastRun = false;
}

const baseEntry = !isNewSession && freshEntry ? entry : undefined;
sessionEntry = {
  ...baseEntry,
  sessionId,
  updatedAt: Date.now(),
  systemSent,
  abortedLastRun,
  thinkingLevel: persistedThinking ?? baseEntry?.thinkingLevel,
  verboseLevel: persistedVerbose ?? baseEntry?.verboseLevel,
  // Model: preserve from base entry. model field > legacy fields
  model: baseEntry?.model ??
    (baseEntry?.providerOverride && baseEntry?.modelOverride
      ? `${baseEntry.providerOverride}/${baseEntry.modelOverride}`
      : baseEntry?.modelOverride) ??
    undefined,
  // Don't copy deprecated fields — they're consumed above into model
  queueMode: baseEntry?.queueMode,
  queueDebounceMs: baseEntry?.queueDebounceMs,
  // ... (rest unchanged)

// --- END REPLACE ---
```

**Chi tiết thay đổi:**
1. Xóa `persistedModelOverride` và `persistedProviderOverride` (lines 892-893) — không cần nữa
2. Xóa `modelOverride:` và `providerOverride:` khỏi sessionEntry construction (lines 911-912)
3. Thêm `model:` field vào sessionEntry construction — ưu tiên `baseEntry.model`, fallback từ deprecated fields
4. Tìm và xóa khai báo biến `persistedModelOverride` và `persistedProviderOverride` (khoảng line 750-755)

---

### STEP 3: Fix `server.ts` — xóa dead code `providerOverride` handler

**File:** `src/gateway/server.ts`
**Lines:** 2497-2504

**Vấn đề:** WS `sessions.patch` handler có block riêng xử lý `providerOverride`:
```typescript
if ("providerOverride" in p) {
  const raw = p.providerOverride;
  if (raw === null) {
    delete next.providerOverride;
  } else if (raw !== undefined) {
    next.providerOverride = String(raw);  // ← GHI deprecated field, KHÔNG update model!
  }
}
```
Nếu client gửi `providerOverride` riêng (không kèm `modelOverride`), nó sẽ ghi vào deprecated field mà không update `model`. Tạo state không nhất quán.

**Sửa:** Xóa toàn bộ block lines 2497-2504. Nếu muốn backward compat, merge provider vào logic `modelOverride` handler phía trên (line 2467-2494).

---

### STEP 4: Fix `server.ts` — `effectiveModel` trong `sessions.list`

**File:** `src/gateway/server.ts`
**Lines:** 987-993

**Hiện tại:**
```typescript
const effectiveModel = (() => {
  if (entry?.model) return entry.model;
  if (entry?.providerOverride && entry?.modelOverride)
    return `${entry.providerOverride}/${entry.modelOverride}`;
  if (entry?.modelOverride) return entry.modelOverride;
  return undefined;
})();
```

**Sửa:** Sau khi step 1-3 đã migrate xong, deprecated fields sẽ không còn tồn tại trong data mới. Giữ backward compat tạm thời, nhưng thêm log warning:

```typescript
const effectiveModel = (() => {
  if (entry?.model) return entry.model;
  // Legacy fallback — sẽ xóa sau khi migration hoàn tất
  if (entry?.providerOverride && entry?.modelOverride)
    return `${entry.providerOverride}/${entry.modelOverride}`;
  if (entry?.modelOverride) return entry.modelOverride;
  return undefined;
})();
```

Phần này giữ nguyên logic, chỉ thêm comment. Không cần thay đổi code.

---

### STEP 5: Fix `sessions.ts` — `updateLastRoute()` không copy deprecated fields

**File:** `src/config/sessions.ts`
**Lines:** 315-316

**Hiện tại:**
```typescript
providerOverride: existing?.providerOverride,
modelOverride: existing?.modelOverride,
```

**Sửa:**
```typescript
// Preserve model field. Deprecated providerOverride/modelOverride are not copied.
model: existing?.model ??
  (existing?.providerOverride && existing?.modelOverride
    ? `${existing.providerOverride}/${existing.modelOverride}`
    : existing?.modelOverride) ??
  undefined,
```

---

### STEP 6: Fix tests

**File:** `src/auto-reply/reply.directive.test.ts`
**Lines:** 594-595, 626-627

**Hiện tại:**
```typescript
expect(entry.modelOverride).toBe("gpt-4.1-mini");
expect(entry.providerOverride).toBe("openai");
```

**Sửa:**
```typescript
expect(entry.model).toBe("openai/gpt-4.1-mini");
```

Tương tự cho line 626-627:
```typescript
expect(entry.model).toBe("anthropic/claude-opus-4-5");
```

---

## Thứ tự thực hiện & dependencies

```
STEP 1 (agent.ts)     ←── CRITICAL, fix ngay, không phụ thuộc step khác
  ↓
STEP 2 (reply.ts)     ←── Fix session load, phụ thuộc hiểu flow từ step 1
  ↓
STEP 3 (server.ts)    ←── Cleanup dead code, nhẹ
  ↓
STEP 4 (server.ts)    ←── Verify only, có thể skip
  ↓
STEP 5 (sessions.ts)  ←── Cleanup, phụ thuộc step 2
  ↓
STEP 6 (tests)        ←── Phải chạy SAU step 2 (vì test verify behavior mới)
```

**Sau mỗi step:** chạy `pnpm build` để verify. Sau step 6: chạy `pnpm test`.

---

## Schema (KHÔNG đổi ngay)

**File:** `src/gateway/protocol/schema.ts` lines 307-308

```typescript
modelOverride: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
providerOverride: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
```

**Giữ nguyên.** Đây là wire protocol — UI gửi `modelOverride` qua WS. WS handler đã convert thành `entry.model` (line 2491). Xóa schema sẽ break UI. Chỉ xóa khi đã update UI gửi field `model` thay vì `modelOverride`.

---

## Bảng tổng hợp tất cả references cần sửa

| File | Lines | Hiện tại | Sửa thành | Step |
|------|-------|----------|-----------|------|
| `commands/agent.ts` | 268-310 | Đọc `modelOverride`/`providerOverride` | Đọc `model` field, fallback deprecated | 1 |
| `auto-reply/reply.ts` | 892-893 | `persistedModelOverride = entry.modelOverride` | Xóa | 2 |
| `auto-reply/reply.ts` | 911-912 | `modelOverride: persistedModelOverride` | `model: baseEntry?.model ?? ...` | 2 |
| `gateway/server.ts` | 2497-2502 | Ghi `providerOverride` riêng | Xóa block | 3 |
| `gateway/server.ts` | 987-993 | Backward compat (OK) | Giữ, thêm comment | 4 |
| `config/sessions.ts` | 315-316 | Copy deprecated fields | Copy `model` field | 5 |
| `reply.directive.test.ts` | 594-595, 626-627 | Assert deprecated fields | Assert `model` field | 6 |

**KHÔNG SỬA (đã đúng):**
- `reply.ts:1108-1165` — storedModel resolution (đã đọc `model` > deprecated, đã normalize bare IDs)
- `reply.ts:1334-1342` — `/model` directive persist (đã ghi `sessionEntry.model`, đã xóa deprecated)
- `reply.ts:1445-1451` — followup directive (đã ghi `sessionEntry.model`, đã xóa deprecated)
- `reply.ts:2023-2069, 2286-2330` — agent run completion (đã ghi `model` field, normalize `provider/model`)
- `agent.ts:409` — post-run persist (`model: modelUsed`) (đã đúng)
- `server.ts:2467-2494` — WS `sessions.patch` modelOverride handler (đã convert → `entry.model`)
- `server.ts:2970-2984` — `chat.send` session creation (đã inherit config default)
- `pi-embedded-runner.ts` — nhận provider/model từ caller, đã đúng
- `system-prompt.ts` — render model info từ runner, đã đúng
- `protocol/schema.ts` — wire protocol, giữ backward compat

---

## Test plan

1. `pnpm build` — no TS errors (sau mỗi step)
2. `pnpm test` — pass (sau step 6)
3. Restart gateway: `systemctl --user restart clawdis-gateway.service`

**Manual tests:**

| Test | Expected |
|------|----------|
| WebUI: đổi model dropdown → `litellm/anthropic-glm47` → gửi "m dùng model gì?" | Agent trả lời `litellm/anthropic-glm47` |
| WebUI: `/model zai/glm-4.7` → gửi message | Agent dùng GLM-4.7 (verify trong session transcript) |
| WebUI: restart gateway → gửi message | Model không reset về default |
| Telegram: gửi `/model zai/glm-4.7` → gửi message | Agent dùng GLM-4.7 |
| Telegram: đổi model → WebUI session không bị ảnh hưởng | Model per-session independent |
| WebUI: `/new` → gửi message | Dùng config default (`gemini/gemini-3-flash-preview`) |
| WebUI: verify `sessions.json` sau switch | `entry.model = "provider/model"`, không có `modelOverride`/`providerOverride` |

---

## Lưu ý cho coding agent

- Đọc `CLAUDE.md` trước — tuân thủ coding principles
- Không tạo file mới — sửa trong file hiện có
- **Pattern tham khảo:** WS `sessions.patch` handler (`server.ts:2467-2494`) là reference implementation đúng
- **Tuyệt đối không sửa:** `pi-embedded-runner.ts`, `system-prompt.ts`, `pi-model-resolver.ts` — chúng đã đúng
- Build check: `pnpm build` sau mỗi step
- Test: `pnpm test` sau step 6
- Sau khi fix xong, chạy gateway và test manual ít nhất 3 scenarios đầu tiên
