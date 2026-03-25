# FIX: WebSocket sessions.patch thiếu modelOverride handler + Gemini turn ordering

Hai bug riêng biệt, cùng gây ra behavior xấu khi chat.

---

## BUG A: Model switch không persist — Agent chạy model cũ

### Triệu chứng

- User click footer dropdown → chọn `zai/glm-4.7`
- Footer hiển thị `glm-4.7` ✅
- Header hiển thị `zai:glm-4.7` ✅
- `sessions.json` vẫn ghi `"model": "gemini-3-flash-preview"` ❌
- Agent chạy gemini, không phải glm-4.7 ❌

### Root Cause

Có **2 handler `sessions.patch`** trong `src/gateway/server.ts`:

| Handler | Location | modelOverride? |
|---------|----------|----------------|
| Bridge handler (`handleBridgeRequest`) | Line **2467-2493** | ✅ Có |
| **WebSocket handler** (main switch-case) | Line **4897-5008** | ❌ **THIẾU** |

WebSocket handler xử lý `thinkingLevel` (line 4934), `verboseLevel` (line 4956), `groupActivation` (line 4978) rồi **nhảy thẳng** tới `store[key] = next` (line 4999) — bỏ qua `modelOverride`.

### Flow chi tiết

```
chat.js:326  switchModel() → PUT /api/agents/{id}/model { model: "zai/glm-4.7" }
  ↓
api.js:1728  → WS request('sessions.patch', { key, modelOverride: "zai/glm-4.7" })
  ↓
server.ts:4897  WebSocket sessions.patch handler
  → thinkingLevel ✅
  → verboseLevel ✅
  → groupActivation ✅
  → modelOverride ❌ MISSING  ← BUG
  → store[key] = next  ← model field KHÔNG được set
  ↓
reply.ts:1115  sessionEntry.model → giá trị cũ → agent chạy model cũ
```

### Fix

**File**: `src/gateway/server.ts`

Thêm block `if ("modelOverride" in p)` vào WebSocket `sessions.patch` handler.

**Vị trí chính xác**: sau `groupActivation` block (line 4997), trước `store[key] = next` (line 4999).

Copy logic từ bridge handler (lines 2467-2493):

```typescript
// INSERT sau line 4997 (sau closing brace của groupActivation block):

if ("modelOverride" in p) {
  const raw = p.modelOverride;
  if (raw === null) {
    delete next.model;
    delete next.modelOverride;
    delete next.providerOverride;
  } else if (raw !== undefined) {
    let normalized = String(raw).trim();
    // If bare model ID (no provider prefix), look up provider from config
    if (!normalized.includes("/")) {
      const providers = cfg.models?.providers ?? {};
      for (const [provId, provCfg] of Object.entries(providers)) {
        const models = (provCfg as { models?: { id: string }[] })
          .models;
        if (
          models?.some((m: { id: string }) => m.id === normalized)
        ) {
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

### Context xung quanh (để locate chính xác)

```typescript
// Line 4978-4997: groupActivation block (ĐÃ CÓ)
              if ("groupActivation" in p) {
                const raw = p.groupActivation;
                // ... validation + normalize ...
                next.groupActivation = normalized;
              }

              // <<< INSERT modelOverride block HERE >>>

// Line 4999: save to store (ĐÃ CÓ)
              store[key] = next;
              await saveSessionStore(storePath, store);
```

### Lưu ý

- `cfg` đã được load ở line 4921: `const cfg = loadConfig();` — dùng trực tiếp.
- Logic **giống hệt** bridge handler — provider lookup từ `cfg.models.providers`.
- `next.modelOverride` và `next.providerOverride` là deprecated fields — cleanup khi có cơ hội.
- **Không cần sửa** frontend, api.js, hay reply.ts — chúng đã đúng.

---

## BUG B: Gemini API reject message thứ 2 — "function call turn" error

### Triệu chứng

- Message đầu tiên agent trả lời OK (có tool calls → text response)
- Message thứ 2 → `0 in / 0 out | $0.0000` — response hoàn toàn trống
- Error trong transcript: `"Please ensure that function call turn comes immediately after a user turn or after a function response turn."`

### Root Cause Analysis (deep dive)

#### Chuỗi sự kiện trong pi-ai SDK

1. `pi-embedded-runner.ts` gọi `session.agent.replaceMessages(prior)` với history đã sanitize
2. `agent.js` (pi-agent-core) gọi `agentLoop()` → `streamSimple()`
3. `streamSimple()` gọi `convertMessages()` trong `google-shared.js`
4. `convertMessages()` gọi `transformMessages()` trong `transorm-messages.js`

#### Bước 4 — transformMessages (transorm-messages.js:29-31)

```javascript
// Nếu message cùng provider+api → GIỮ NGUYÊN, kể cả thoughtSignature
if (assistantMsg.provider === model.provider && assistantMsg.api === model.api) {
    return msg;  // ← KHÔNG transform gì cả
}
```

Khi history messages cùng provider `google` với model hiện tại → `transformMessages` **không strip thinking blocks** vì nghĩ chúng đã valid.

#### Bước 3 — convertMessages (google-shared.js:69-81)

```javascript
else if (block.type === "toolCall") {
    const part = {
        functionCall: { id: block.id, name: block.name, args: block.arguments },
    };
    if (block.thoughtSignature) {
        part.thoughtSignature = block.thoughtSignature;  // ← GỬI SIGNATURE CŨ
    }
    parts.push(part);
}
```

**Signature từ session trước** (invalid) được gửi cho Gemini API → Gemini reject.

#### Tại sao strip trong pi-embedded-runner.ts không hoạt động

Strip code (line 396-400) **tạo object MỚI** cho mỗi block:
```typescript
const { thoughtSignature: _sig, ...rest } = block;
return rest;
```

**Nhưng** `session.messages` được load bởi `SessionManager.open()` VÀ session manager có thể **re-parse** từ JSONL file, lấy lại data GỐC có `thoughtSignature`. Khi `agent.prompt()` chạy, nó dùng `this._state.messages` — nhưng messages này có thể đã bị override bởi agent-loop internal state, hoặc session manager re-read.

**Cần verify**: thêm debug log ngay trước `replaceMessages` để xác nhận sanitize code chạy đúng. (Đã thêm — cần test.)

### Fix (2 layers)

#### Layer 1: Strip thoughtSignature trước replaceMessages (ĐÃ CÓ)

`pi-embedded-runner.ts` line 363-416: strip `thoughtSignature` từ content blocks + xóa empty text blocks. **Đã implement**, cần verify hoạt động.

#### Layer 2: Patch pi-ai google-shared.js — KHÔNG gửi old signatures

**File**: `node_modules/.pnpm/@mariozechner+pi-ai@0.31.1_.../node_modules/@mariozechner/pi-ai/dist/providers/google-shared.js`

Dùng pnpm patch:

```bash
# Tạo patch
pnpm patch @mariozechner/pi-ai@0.31.1
# Edit file providers/google-shared.js line 77-79:
# XÓA block:
#   if (block.thoughtSignature) {
#       part.thoughtSignature = block.thoughtSignature;
#   }
# Áp dụng patch
pnpm patch-commit <path>
```

**Hoặc** edit trực tiếp file đã patch (đã có patch_hash trong path — codebase đã dùng pnpm patch):

Tìm file patch hiện có:
```bash
ls patches/
# hoặc
grep "patchedDependencies" package.json
```

Sửa patch để thêm: trong `convertMessages`, khi build `functionCall` part cho Gemini, **KHÔNG copy `thoughtSignature`** từ history blocks. Signatures chỉ có ý nghĩa trong streaming response hiện tại, không khi replay.

#### Layer 3 (backup): Strip trong transformMessages

Nếu không muốn patch pi-ai, thêm vào `pi-embedded-runner.ts` — sau strip thoughtSignature block, **xóa luôn `provider` và `api` fields** từ assistant messages trong history:

```typescript
// Force transformMessages to treat all history as cross-provider
// so it strips thinking blocks and signatures properly
prior = prior.map((msg) => {
  const m = msg as { role?: string; provider?: string; api?: string };
  if (m.role !== "assistant") return msg;
  const { provider: _p, api: _a, ...rest } = m as Record<string, unknown>;
  return rest as typeof msg;
});
```

**Vị trí**: sau block strip thoughtSignature (line ~416), trước `while (prior[0]?.role !== "user")`.

**Tại sao hoạt động**: `transformMessages` (transorm-messages.js:29-31) check `assistantMsg.provider === model.provider`. Nếu assistant message **không có provider field** → `undefined !== "google"` → trigger transformation → thinking blocks bị convert thành text, signatures bị strip.

**RECOMMEND Layer 3** — đơn giản nhất, không cần patch dependency, fix root cause (force cross-provider transform).

### Files cần sửa

| File | Sửa gì |
|------|--------|
| `src/agents/pi-embedded-runner.ts` | Thêm strip `provider`/`api` từ assistant messages trong history (sau line ~416) |

### Code chính xác

```typescript
// INSERT sau line 416 (sau closing brace của strip thoughtSignature block):
// Trước: while (prior.length > 0 && prior[0].role !== "user")

// Force cross-provider transform: remove provider/api from assistant history
// messages so pi-ai transformMessages() strips thinking blocks and signatures
// instead of passing them through unchanged (same-provider shortcut).
prior = prior.map((msg) => {
  const m = msg as { role?: string };
  if (m.role !== "assistant") return msg;
  const rec = msg as Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { provider: _p, api: _a, ...rest } = rec;
  return rest as typeof msg;
});
```

---

## Verify (cả 2 bugs)

```bash
pnpm build && pnpm lint
systemctl --user restart clawdis-gateway.service
```

### Test BUG A (model persist):
1. Mở WebUI → click model switcher → chọn `zai/glm-4.7`
2. Check `~/.clawdis/sessions/sessions.json` → `"model"` phải = `"zai/glm-4.7"`
3. Gửi message → agent chạy trên glm-4.7 (check transcript JSONL)
4. Hỏi agent "đang dùng model gì?" → trả lời glm-4.7

### Test BUG B (Gemini turn ordering):
1. Fresh session (reset hoặc `/new`)
2. Gửi message đầu tiên → agent trả lời OK (có tool calls)
3. Gửi message thứ 2 → agent phải trả lời (KHÔNG còn 0 in/0 out)
4. Gửi message thứ 3, 4, 5 → tất cả phải hoạt động

### Test kết hợp:
1. Switch model giữa session
2. Gửi message → agent chạy model mới VÀ trả lời được (không lỗi turn ordering)

---

## Xóa debug log

Sau khi verify xong, xóa debug log block trong `pi-embedded-runner.ts` (console.warn `thoughtSignature still present`).
