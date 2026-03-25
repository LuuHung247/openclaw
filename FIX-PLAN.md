# FIX PLAN — Session & Model Issues

Thứ tự: đơn giản fix trước, phức tạp sau.

---

## FIX 1: First message mất khi tạo session mới (đơn giản nhất)

### Problem

`appendUserMessageToSessionFile()` ở `src/gateway/server.ts:798-805` return sớm khi session file chưa tồn tại:

```typescript
const filePath = candidates.find((p) => fs.existsSync(p));
if (!filePath) return; // ← file chưa có → mất message
```

Thứ tự thực thi hiện tại:
1. `appendUserMessageToSessionFile()` — cố ghi message nhưng file chưa có → **bỏ qua**
2. `agentCommand()` → `ensureSessionHeader()` — tạo file
3. Agent xử lý message, ghi response

### Fix

Khi file chưa tồn tại → tự tạo file + ghi session header + ghi user message, thay vì return.

### File cần sửa

**`src/gateway/server.ts`** — function `appendUserMessageToSessionFile()` (line ~798)

### Code hướng dẫn

```typescript
function appendUserMessageToSessionFile(
  sessionId: string,
  storePath: string | undefined,
  text: string,
): void {
  const candidates = resolveSessionTranscriptCandidates(sessionId, storePath);
  let filePath = candidates.find((p) => fs.existsSync(p));

  // Session file chưa tồn tại → tạo mới với session header
  if (!filePath) {
    filePath = candidates[0]; // preferred path
    if (!filePath) return;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const header = {
        type: "session",
        version: 2,
        id: sessionId,
        timestamp: new Date().toISOString(),
      };
      fs.writeFileSync(filePath, `${JSON.stringify(header)}\n`, "utf-8");
    } catch {
      return; // non-critical — agent runner sẽ tạo file sau
    }
  }

  // Phần còn lại giữ nguyên (read last entry for parentId, dedup check, append)
  // ...
}
```

### Lưu ý

- `ensureSessionHeader()` trong `pi-embedded-helpers.ts` đã có guard `await fs.stat(file)` — nếu file đã tồn tại thì return luôn → **không conflict**.
- Session header format phải khớp: `{ type: "session", version: 2, id, timestamp }` — xem `pi-embedded-helpers.ts:28-35`.
- Không cần field `cwd` trong header ở đây — agent runner sẽ ghi đè nếu cần.

### Test

1. `pnpm build` — verify no TS errors
2. Restart gateway: `systemctl --user restart clawdis-gateway.service`
3. Xóa session hiện tại (hoặc dùng `/new`)
4. Gửi message đầu tiên qua WebUI
5. Refresh browser → message đầu tiên phải xuất hiện trong history

---

## FIX 2: Model per-session — gộp `modelOverride` + `providerOverride` → `model` duy nhất

### Problem

Hiện tại 3 field liên quan đến model trong SessionEntry:
- `model` — model đã dùng lần cuối (set sau khi agent run xong)
- `modelOverride` — ý định chuyển model (set khi user `/model x`)
- `providerOverride` — provider tách riêng

Điều này gây:
- `sessions.list` trả `entry.model` (last-used) chứ không phải effective model
- Đổi default ở Settings xóa hết override mọi session
- UI hiển thị model sai

### Design mới

Mỗi session giữ **1 field `model`** duy nhất = model hiện tại cho session đó.

```
session.model = "provider/model-id"   // single source of truth
```

Không còn `modelOverride` / `providerOverride`.

### Migration logic

Khi load session entry có `modelOverride` (data cũ):
```typescript
// Backward compat: gộp override fields → model
if (entry.modelOverride && !entry.model?.includes('/')) {
  const provider = entry.providerOverride || defaultProvider;
  entry.model = `${provider}/${entry.modelOverride}`;
  delete entry.modelOverride;
  delete entry.providerOverride;
  // save lại
}
```

### Files cần sửa (theo thứ tự)

#### 2a. `src/config/sessions.ts` — SessionEntry type

Giữ `modelOverride` và `providerOverride` tạm thời (backward compat) nhưng đánh dấu `@deprecated`:

```typescript
export type SessionEntry = {
  // ...
  model?: string; // format: "provider/model-id" — single source of truth

  /** @deprecated — dùng model field thay thế */
  modelOverride?: string;
  /** @deprecated — dùng model field thay thế */
  providerOverride?: string;
  // ...
};
```

#### 2b. `src/gateway/server.ts` — `sessions.patch` handler (line ~2415)

Khi nhận `modelOverride` từ client → ghi vào `model` field (format `provider/model-id`):

```typescript
if ("modelOverride" in p) {
  const raw = p.modelOverride;
  if (raw === null) {
    delete next.model;           // reset → dùng config default khi chạy
    delete next.modelOverride;   // cleanup deprecated
    delete next.providerOverride;
  } else if (raw !== undefined) {
    const normalized = String(raw);
    // Nếu đã có format "provider/model" → dùng luôn
    // Nếu chỉ có "model" → giữ nguyên (runtime sẽ dùng default provider)
    next.model = normalized;
    delete next.modelOverride;   // cleanup deprecated
    delete next.providerOverride;
  }
}
```

#### 2c. `src/gateway/server.ts` — `listSessionsFromStore()` (line ~947)

Trả effective model:

```typescript
// Trong .map() callback:
const effectiveModel = (() => {
  // Ưu tiên: model field mới > legacy override > config default
  if (entry?.model) return entry.model;
  if (entry?.providerOverride && entry?.modelOverride)
    return `${entry.providerOverride}/${entry.modelOverride}`;
  if (entry?.modelOverride) return entry.modelOverride;
  return null; // frontend sẽ hiển thị config default
})();

return {
  // ...
  model: effectiveModel,
  // ...
};
```

#### 2d. `src/auto-reply/reply.ts` — model resolution (line ~1123)

Đơn giản hóa: đọc `sessionEntry.model` trực tiếp.

```typescript
// THAY THẾ đoạn storedProviderOverride/storedModelOverride (line 1123-1132):
const storedModel = sessionEntry?.model?.trim();
if (storedModel) {
  const parts = storedModel.split("/");
  if (parts.length >= 2) {
    const candidateProvider = parts[0];
    const candidateModel = parts.slice(1).join("/");
    const key = modelKey(candidateProvider, candidateModel);
    if (allowedModelKeys.size === 0 || allowedModelKeys.has(key)) {
      provider = candidateProvider;
      model = candidateModel;
    }
  } else {
    // model without provider → dùng default provider
    const key = modelKey(defaultProvider, storedModel);
    if (allowedModelKeys.size === 0 || allowedModelKeys.has(key)) {
      provider = defaultProvider;
      model = storedModel;
    }
  }
}
```

Tương tự cho đoạn `hasStoredOverride` check (line 1106-1120).

#### 2e. `src/auto-reply/reply.ts` — persist model sau directive (line ~1301)

```typescript
// Khi user /model x → persist
if (modelSelection.isDefault) {
  delete sessionEntry.model; // reset → config default
} else {
  sessionEntry.model = `${modelSelection.provider}/${modelSelection.model}`;
}
// Cleanup deprecated fields
delete sessionEntry.modelOverride;
delete sessionEntry.providerOverride;
```

#### 2f. `src/auto-reply/reply.ts` — persist model sau agent run (line ~2021)

Đoạn này đã ghi `model: modelUsed` → giữ nguyên, nhưng đảm bảo format `provider/model-id`.

#### 2g. `src/commands/status.ts` — đọc `entry.model` trực tiếp

Đoạn `const model = entry?.model ?? configModel ?? null;` (line 76) — đã đúng, giữ nguyên.

### Test

1. `pnpm build`
2. Restart gateway
3. Test: `/model zai/glm-4.7` ở WebUI → verify session.model = "zai/glm-4.7"
4. Test: gửi message → verify agent dùng đúng model
5. Test: `/model` (không arg) → verify hiển thị model hiện tại đúng
6. Test: đổi model ở WebUI → verify Telegram session KHÔNG bị ảnh hưởng
7. Test: backward compat — session cũ có modelOverride → verify vẫn hoạt động

---

## FIX 3: Settings page không cascade xóa session overrides

### Problem

`saveDefaultModel()` trong `ui/js/pages/settings.js:232-240` loop xóa `modelOverride` cho TẤT CẢ sessions.

### Fix

Xóa đoạn loop. Đổi config default chỉ ảnh hưởng session MỚI. Session đang có giữ model riêng.

### File cần sửa

**`ui/js/pages/settings.js`** — function `saveDefaultModel()` (line ~227)

```javascript
async saveDefaultModel() {
  if (!this.defaultModel) return;
  this.defaultModelSaving = true;
  try {
    await OpenFangAPI.post('/api/config', { agent: { model: this.defaultModel } });
    // KHÔNG còn xóa override sessions — mỗi session giữ model riêng
    await this.loadConfig();
    window.dispatchEvent(new CustomEvent('openclaw:model-changed', { detail: { model: this.defaultModel } }));
    OpenFangToast.success('Default model saved: ' + this.defaultModel + '\n(Active sessions keep their current model)');
  } catch(e) {
    OpenFangToast.error('Failed to save model: ' + e.message);
  }
  this.defaultModelSaving = false;
},
```

### Test

1. Set model cho WebUI session: `/model zai/glm-4.7`
2. Vào Settings → đổi default model thành `litellm/gemini-3-flash`
3. Quay lại WebUI chat → verify model vẫn là `zai/glm-4.7`
4. Tạo session mới (`/new`) → verify model mới = `litellm/gemini-3-flash` (inherit default)

---

## FIX 4: Chat page model display — dùng event detail thay vì re-fetch

### Problem

Chat page khi nhận `openclaw:model-changed` gọi `getStatus()` có cache 10s → có thể trả model cũ.
Và `getStatus()` trả `defaults.model` (config default) chứ không phải model của session hiện tại.

### Fix

Sau FIX 3, event `openclaw:model-changed` chỉ có nghĩa "default đã đổi" → hiển thị thông báo nhưng KHÔNG đổi `currentAgent.model` (session giữ model riêng).

### File cần sửa

**`ui/js/pages/chat.js`** — event handler (line ~161)

```javascript
window.addEventListener('openclaw:model-changed', function(e) {
  var newDefault = (e.detail && e.detail.model) || '';
  if (!newDefault) return;
  var displayModel = parseModelName(newDefault) || newDefault;
  // Chỉ thông báo — KHÔNG đổi currentAgent.model
  self.messages.push({
    id: ++msgId, role: 'system',
    text: 'Default model changed to **' + displayModel + '**. Your current session keeps its model. Use `/model ' + newDefault + '` to switch this session.',
    meta: '', tools: []
  });
  self.scrollToBottom();
});
```

### Bonus: Fix `/model` command hiển thị (line ~402)

```javascript
case '/model':
  if (self.currentAgent) {
    if (cmdArgs) {
      OpenFangAPI.put('/api/agents/' + self.currentAgent.id + '/model', { model: cmdArgs }).then(function() {
        self.currentAgent.model = cmdArgs;  // lưu full "provider/model"
        self.currentAgent.model_name = parseModelName(cmdArgs);
        self.messages.push({ id: ++msgId, role: 'system', text: 'Model switched to: `' + parseModelName(cmdArgs) + '`', meta: '', tools: [] });
        self.scrollToBottom();
      }).catch(function(e) { OpenFangToast.error('Model switch failed: ' + e.message); });
    } else {
      // Hiển thị model hiện tại — dùng currentAgent.model (đã sync với session)
      var model = self.currentAgent.model || '?';
      var displayModel = parseModelName(model) || model;
      self.messages.push({ id: ++msgId, role: 'system', text: '**Current Model**: `' + displayModel + '` (`' + model + '`)', meta: '', tools: [] });
      self.scrollToBottom();
    }
  }
  break;
```

Xóa đoạn gọi `getSessions()` cũ (line 412-428) — không cần nữa vì `currentAgent.model` đã được sync.

### Test

1. Ở WebUI gõ `/model` → verify hiển thị model hiện tại đúng
2. Gõ `/model zai/glm-4.7` → verify hiển thị "glm-4.7"
3. Vào Settings đổi default → verify chat chỉ thông báo, KHÔNG đổi model session

---

## FIX 5: Invalidate status cache khi model thay đổi

### Problem

`api.js` cache `getStatus()` 10 giây → model cũ hiển thị sau khi đổi.

### Fix

**`ui/js/api.js`** — thêm invalidate function + gọi khi model thay đổi.

```javascript
// Thêm function
function invalidateStatusCache() {
  _statusCache = null;
  _statusCacheAt = 0;
}

// Export
// Trong return object cuối file, thêm:
invalidateStatusCache: invalidateStatusCache,

// Gọi trong PUT /api/agents/{id}/model handler:
// (line ~1726, sau request sessions.patch)
invalidateStatusCache();
```

---

## FIX 6: Session mới inherit model từ config default

### Problem hiện tại

Khi tạo session mới, `sessionEntry` không có field `model` → runtime dùng config default. Đúng behavior, nhưng UI không biết model nào đang dùng cho session mới (hiển thị "?").

### Fix

Khi tạo sessionEntry mới trong `chat.send` handler (line ~2833), gán `model` = config default:

**`src/gateway/server.ts`** — chat.send handler (line ~2830)

```typescript
const { storePath, store, entry } = loadSessionEntry(p.sessionKey);
const now = Date.now();
const sessionId = entry?.sessionId ?? randomUUID();

// Nếu session mới → inherit model từ config
const cfg = loadConfig();
const configModel = resolveConfiguredModelRef({
  cfg,
  defaultProvider: DEFAULT_PROVIDER,
  defaultModel: DEFAULT_MODEL,
});
const inheritedModel = `${configModel.provider}/${configModel.model}`;

const sessionEntry: SessionEntry = {
  sessionId,
  updatedAt: now,
  model: entry?.model ?? inheritedModel,  // ← inherit config default cho session mới
  thinkingLevel: entry?.thinkingLevel,
  verboseLevel: entry?.verboseLevel,
  // ...
};
```

### Lưu ý

- `loadConfig()` đã được gọi nhiều nơi khác trong cùng handler → không phải overhead mới.
- `resolveConfiguredModelRef` import từ `agents/model-selection.ts`.

---

## FIX 7: Agent system prompt đã có model info (verify only)

### Status: Đã có sẵn — không cần sửa

`pi-embedded-runner.ts:275-280` đã truyền `runtimeInfo.model = provider/modelId`.
`system-prompt.ts:67` đã render `Model: ${runtimeInfo.model}`.

→ Agent biết model đang dùng. Nếu user hỏi "mày dùng model gì?", agent trả lời được.

**Chỉ cần verify**: gửi message hỏi agent "bạn đang dùng model gì?" → confirm trả lời đúng.

---

## Tóm tắt thứ tự thực hiện

| # | Fix | Độ khó | Risk | Files |
|---|-----|--------|------|-------|
| 1 | First message mất | Dễ | Thấp | `server.ts` (1 function) |
| 3 | Settings không cascade xóa | Dễ | Thấp | `settings.js` (xóa code) |
| 4 | Chat page model display | Dễ | Thấp | `chat.js` (event handler + /model) |
| 5 | Invalidate status cache | Dễ | Thấp | `api.js` (thêm 1 function) |
| 2 | Model per-session | Trung bình | Trung bình | `sessions.ts`, `server.ts`, `reply.ts`, `status.ts` |
| 6 | Session mới inherit model | Dễ | Thấp | `server.ts` (chat.send handler) |
| 7 | System prompt model info | Không cần sửa | — | Verify only |

## FIX 8: Model Switch hiển thị trên lịch sử chat + Footer Model Selector (học từ Openfang) ✅ DONE

### Mục tiêu

1. **System message trong chat history** khi đổi model (giống Claude Code: "Set model to opus (claude-opus-4-6)")
2. **Footer model selector button** (học từ openfang) — dropdown ở footer thay vì chỉ `/model` command

### 8A. System message khi đổi model

Khi user đổi model bằng bất kỳ cách nào (dropdown, `/model`, Settings), hiển thị system message trong chat:

```
────────────────────────────────────
  ⚙ Model changed to glm-4.7 (zai)
────────────────────────────────────
```

#### Cách hiển thị

Thêm message type mới `role: "model-switch"` (render khác system message thường — nhỏ gọn, centered, có icon):

**`ui/css/components.css`** — thêm CSS:

```css
/* Model switch indicator — inline divider style */
.message.model-switch {
  max-width: 100%;
  justify-content: center;
}
.message.model-switch .message-bubble {
  background: none;
  border: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  width: 100%;
}
.message.model-switch .model-switch-line {
  flex: 1;
  height: 1px;
  background: var(--border);
}
.message.model-switch .model-switch-label {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-dim);
  white-space: nowrap;
  display: flex;
  align-items: center;
  gap: 4px;
}
```

**`ui/index_body.html`** — thêm template cho model-switch message:

Trong message loop, thêm block đặc biệt cho `role === "model-switch"`:

```html
<!-- Model switch indicator -->
<template x-if="msg.role === 'model-switch'">
  <div class="message model-switch">
    <div class="message-bubble">
      <div class="model-switch-line"></div>
      <div class="model-switch-label">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
        <span x-text="msg.text"></span>
      </div>
      <div class="model-switch-line"></div>
    </div>
  </div>
</template>
```

**`ui/js/pages/chat.js`** — push model-switch message khi đổi model:

```javascript
// Helper function — gọi ở mọi chỗ đổi model
function pushModelSwitchMessage(modelId, provider) {
  var displayName = parseModelName(modelId) || modelId;
  var label = provider ? displayName + ' (' + provider + ')' : displayName;
  self.messages.push({
    id: ++msgId,
    role: 'model-switch',
    text: 'Set model to ' + label,
    meta: '', tools: []
  });
  self.scrollToBottom();
}
```

Gọi `pushModelSwitchMessage()` ở:
1. `/model` command handler (thay thế system message hiện tại)
2. `switchModel()` function (dropdown)
3. `openclaw:model-changed` event (khi Settings đổi default — optional, có thể chỉ notify)

#### Lưu ý render

- Message `role: "model-switch"` phải bị **skip** bởi `x-if="msg.role === 'user' || msg.role === 'agent'"` conditions
- Nếu chat history load từ server (session restore), model-switch messages là **client-only** (không persist vào session JSONL) — giống cách Claude Code xử lý

### 8B. Footer Model Selector (học từ Openfang)

Port model switcher từ openfang footer vào openclaw. Hiện tại openclaw chỉ có `/model` command + autocomplete picker popup — thêm **button ở footer** cho UX tốt hơn.

#### Layout thay đổi

Hiện tại `input-footer` chỉ có: `token count | tip bar`

Thêm model switcher button vào bên trái:

```
[🔷 glm-4.7 ▼]  ~1200 tokens  |  Tip: Press / for commands
```

#### HTML — `ui/index_body.html`

Thêm vào `.input-footer`, trước token count:

```html
<div class="input-footer">
  <div class="flex items-center gap-2">
    <!-- Model Switcher Button -->
    <div style="position:relative" x-show="currentAgent"
         @click.outside="showModelSwitcher = false"
         @keydown.escape.window="showModelSwitcher = false">
      <button class="model-switcher-btn"
              @click="toggleModelSwitcher()"
              :disabled="sending"
              title="Switch model (Ctrl+M)">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
        </svg>
        <span class="model-switcher-label" x-text="modelDisplayName || 'Model'"></span>
        <svg class="model-switcher-chevron" :class="{'open': showModelSwitcher}"
             width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      <!-- Dropdown (popup lên trên) -->
      <div class="model-switcher-dropdown" x-show="showModelSwitcher"
           x-transition:enter="transition ease-out duration-150"
           x-transition:enter-start="opacity-0 transform translate-y-1"
           x-transition:enter-end="opacity-100 transform translate-y-0">
        <div class="model-switcher-search">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;opacity:0.5">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input id="model-switcher-search" type="text"
                 x-model="modelSwitcherFilter"
                 placeholder="Search models..."
                 @keydown.escape.stop="showModelSwitcher = false"
                 @keydown.arrow-down.prevent="modelSwitcherIdx = Math.min(modelSwitcherIdx + 1, filteredSwitcherModels.length - 1)"
                 @keydown.arrow-up.prevent="modelSwitcherIdx = Math.max(modelSwitcherIdx - 1, 0)"
                 @keydown.enter.prevent="filteredSwitcherModels[modelSwitcherIdx] && switchModel(filteredSwitcherModels[modelSwitcherIdx])">
          <select x-model="modelSwitcherProviderFilter"
                  style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--text-dim);font-size:11px;padding:2px 6px;cursor:pointer;font-family:var(--font-mono);flex-shrink:0">
            <option value="">All</option>
            <template x-for="pn in switcherProviders" :key="pn">
              <option :value="pn" x-text="pn"></option>
            </template>
          </select>
        </div>
        <div x-show="modelSwitching" style="display:flex;align-items:center;justify-content:center;padding:12px;gap:8px">
          <div class="tool-card-spinner"></div>
          <span class="text-xs text-dim">Switching...</span>
        </div>
        <div class="model-switcher-list" x-show="!modelSwitching">
          <template x-if="groupedSwitcherModels.length === 0">
            <div style="padding:16px;text-align:center" class="text-xs text-dim">No models found</div>
          </template>
          <template x-for="group in groupedSwitcherModels" :key="group.provider">
            <div>
              <div class="model-switcher-group-header" x-text="group.provider"></div>
              <template x-for="m in group.models" :key="m.id">
                <div class="model-switcher-item"
                     :class="{'active': currentAgent && m.id === currentAgent.model_name}"
                     @click="switchModel(m)">
                  <div style="flex:1;min-width:0">
                    <div style="display:flex;align-items:center;gap:6px">
                      <span class="model-switcher-item-name" x-text="m.display_name || m.id"></span>
                      <span class="model-switcher-tier" :class="'tier-' + (m.tier || 'balanced').toLowerCase()"
                            x-text="m.tier || 'Balanced'"></span>
                    </div>
                    <div style="display:flex;align-items:center;gap:6px;margin-top:2px">
                      <span class="text-xs text-dim" x-text="m.id" style="font-family:var(--font-mono)"></span>
                      <span class="text-xs text-dim" x-show="m.context_window"
                            x-text="m.context_window >= 1000000 ? (m.context_window/1000000).toFixed(1)+'M' : Math.round(m.context_window/1000)+'K'"></span>
                    </div>
                  </div>
                  <svg x-show="currentAgent && m.id === currentAgent.model_name"
                       width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="3">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                </div>
              </template>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- Token count (giữ nguyên) -->
    <span class="text-xs text-dim" x-text="tokenCount > 0 ? ..."></span>
    ...
  </div>
</div>
```

#### JS — `ui/js/pages/chat.js`

Thêm các state và methods (port từ openfang):

```javascript
// === State mới (thêm vào chatPage() return object) ===
showModelSwitcher: false,
modelSwitcherFilter: '',
modelSwitcherProviderFilter: '',
modelSwitcherIdx: 0,
modelSwitching: false,
_modelCache: null,
_modelCacheTime: 0,

// === Computed properties ===
get modelDisplayName() {
  if (!this.currentAgent) return '';
  var name = this.currentAgent.model_name || '';
  var short = name.replace(/-\d{8}$/, '');  // strip date suffix
  return short.length > 24 ? short.substring(0, 22) + '…' : short;
},

get switcherProviders() {
  var seen = {};
  (this._modelCache || []).forEach(function(m) { seen[m.provider] = true; });
  return Object.keys(seen).sort();
},

get filteredSwitcherModels() {
  var models = this._modelCache || [];
  var provFilter = this.modelSwitcherProviderFilter;
  var textFilter = this.modelSwitcherFilter ? this.modelSwitcherFilter.toLowerCase() : '';
  if (!provFilter && !textFilter) return models;
  return models.filter(function(m) {
    if (provFilter && m.provider !== provFilter) return false;
    if (textFilter) {
      return m.id.toLowerCase().indexOf(textFilter) !== -1 ||
             (m.display_name || '').toLowerCase().indexOf(textFilter) !== -1 ||
             m.provider.toLowerCase().indexOf(textFilter) !== -1;
    }
    return true;
  });
},

get groupedSwitcherModels() {
  var filtered = this.filteredSwitcherModels;
  var groups = {}, order = [];
  filtered.forEach(function(m) {
    if (!groups[m.provider]) { groups[m.provider] = []; order.push(m.provider); }
    groups[m.provider].push(m);
  });
  return order.map(function(p) {
    return { provider: p.charAt(0).toUpperCase() + p.slice(1), models: groups[p] };
  });
},

// === Methods ===
toggleModelSwitcher() {
  if (this.showModelSwitcher) { this.showModelSwitcher = false; return; }
  var self = this;
  var now = Date.now();
  // Cache 5 phút
  if (this._modelCache && (now - this._modelCacheTime) < 300000) {
    this.modelSwitcherFilter = '';
    this.modelSwitcherProviderFilter = '';
    this.modelSwitcherIdx = 0;
    this.showModelSwitcher = true;
    this.$nextTick(function() {
      var el = document.getElementById('model-switcher-search');
      if (el) el.focus();
    });
    return;
  }
  OpenFangAPI.get('/api/models').then(function(data) {
    var models = (data.models || []).filter(function(m) { return m.available; });
    self._modelCache = models;
    self._modelCacheTime = Date.now();
    self.modelSwitcherFilter = '';
    self.modelSwitcherProviderFilter = '';
    self.modelSwitcherIdx = 0;
    self.showModelSwitcher = true;
    self.$nextTick(function() {
      var el = document.getElementById('model-switcher-search');
      if (el) el.focus();
    });
  }).catch(function(e) {
    OpenFangToast.error('Failed to load models: ' + e.message);
  });
},

switchModel(model) {
  if (!this.currentAgent) return;
  if (model.id === this.currentAgent.model_name) {
    this.showModelSwitcher = false;
    return;
  }
  var self = this;
  this.modelSwitching = true;
  OpenFangAPI.put('/api/agents/' + this.currentAgent.id + '/model', { model: model.id }).then(function(resp) {
    var resolvedModel = (resp && resp.model) || model.id;
    var resolvedProvider = (resp && resp.provider) || model.provider;
    self.currentAgent.model_name = resolvedModel;
    if (resolvedProvider) self.currentAgent.model_provider = resolvedProvider;
    // Hiển thị model switch message trong chat
    pushModelSwitchMessage(resolvedModel, resolvedProvider);
    self.showModelSwitcher = false;
    self.modelSwitching = false;
  }).catch(function(e) {
    OpenFangToast.error('Switch failed: ' + e.message);
    self.modelSwitching = false;
  });
},
```

#### Keyboard shortcut

Trong `init()`, thêm **Ctrl+M** listener (xem openfang chat.js:153-157):

```javascript
// Ctrl+M for model switcher
if ((e.ctrlKey || e.metaKey) && e.key === 'm' && self.currentAgent) {
  e.preventDefault();
  self.toggleModelSwitcher();
}
```

#### CSS — `ui/css/components.css`

Copy toàn bộ `.model-switcher-*` CSS từ openfang (lines 932-1052 trong openfang `components.css`). Gồm:

```css
/* Model Switcher */
.model-switcher-btn { ... }          /* pill button */
.model-switcher-label { ... }        /* truncated label */
.model-switcher-chevron { ... }      /* rotating arrow */
.model-switcher-dropdown { ... }     /* popup container */
.model-switcher-search { ... }       /* search bar */
.model-switcher-list { ... }         /* scrollable list */
.model-switcher-group-header { ... } /* provider header */
.model-switcher-item { ... }         /* model row */
.model-switcher-item-name { ... }    /* model name */
.model-switcher-tier { ... }         /* tier badge */
.tier-frontier { ... }               /* purple */
.tier-smart { ... }                  /* blue */
.tier-balanced { ... }               /* green */
.tier-fast { ... }                   /* amber */
.tier-local { ... }                  /* gray */
```

Xem chi tiết CSS tại: `/home/hunglk/Documents/VSCode/AI-Agens/openfang/crates/openfang-api/static/css/components.css:932-1052`

### Thứ tự implement FIX 8

| # | Task | Độ khó | Files |
|---|------|--------|-------|
| 8A-1 | CSS cho model-switch message | Dễ | `components.css` |
| 8A-2 | HTML template cho model-switch | Dễ | `index_body.html` |
| 8A-3 | `pushModelSwitchMessage()` helper + gọi | Dễ | `chat.js` |
| 8B-1 | Copy CSS model-switcher từ openfang | Dễ | `components.css` |
| 8B-2 | HTML model-switcher button + dropdown | Trung bình | `index_body.html` |
| 8B-3 | JS state + computed + methods | Trung bình | `chat.js` |
| 8B-4 | Ctrl+M keyboard shortcut | Dễ | `chat.js` |
| 8B-5 | Cleanup: xóa model autocomplete picker cũ | Dễ | `chat.js`, `index_body.html` |

### Lưu ý

- **Model autocomplete picker cũ** (slash-menu style, line 1022-1034 trong index_body.html) có thể giữ lại song song HOẶC xóa — footer dropdown đã thay thế chức năng. Recommend: **xóa** để tránh duplicate UX.
- **`/model` command** vẫn giữ — nhưng khi có args thì gọi `switchModel()` internally (reuse logic).
- **Openfang tách model list theo provider group** (Anthropic, OpenAI, Groq...) — rất đẹp, nên copy.
- **Active model highlight** (checkmark icon) — copy từ openfang.
- **`/api/models` endpoint** — openclaw đã có sẵn (dùng cho picker cũ), kiểm tra response format có `models[]` array với `available`, `provider`, `display_name`, `tier`, `context_window`.

### Test FIX 8

- [ ] Đổi model qua dropdown → model-switch message hiển thị trong chat (centered, divider style)
- [ ] Đổi model qua `/model x` → model-switch message hiển thị
- [ ] Ctrl+M → dropdown mở
- [ ] Search + filter provider trong dropdown hoạt động
- [ ] Model hiện tại có checkmark trong dropdown
- [ ] Dropdown đóng khi click outside / Escape
- [ ] Khi đang streaming (sending=true), dropdown button disabled
- [ ] Header vẫn hiển thị model đúng sau switch

### Reference files (openfang)

| Purpose | Openfang file | Lines |
|---------|---------------|-------|
| HTML template | `openfang/crates/openfang-api/static/index_body.html` | 759-808 |
| JS logic | `openfang/crates/openfang-api/static/js/pages/chat.js` | 96-278 |
| CSS styles | `openfang/crates/openfang-api/static/css/components.css` | 932-1052 |

---

## FIX 9: Agent trả lời sai model sau khi đổi giữa session (CRITICAL)

### Problem (đã confirm qua screenshot)

Sau khi đổi model qua footer dropdown:
- **Footer**: hiển thị `anthropic-glm47` (đúng)
- **Header**: hiển thị `litellm:anthropic-glm47` (đúng)
- **Agent response**: "đang dùng gemini/gemini-3-flash-preview" (SAI — model cũ)

### Root Cause

Khi user hỏi "đang dùng model gì?", agent đọc **conversation history** trong session JSONL, trong đó system message đầu session chứa:

```
Model: gemini/gemini-3-flash-preview
```

System prompt được build **1 lần** khi agent run bắt đầu (`pi-embedded-runner.ts:275`), ghi `runtimeInfo.model = provider/modelId`. Nhưng sau khi đổi model qua `sessions.patch`, lần chạy agent tiếp theo:

1. `reply.ts:1132-1149` — resolve model MỚI từ `sessionEntry.model` → đúng
2. `pi-embedded-runner.ts:275` — build system prompt với model MỚI → đúng
3. **NHƯNG** session transcript vẫn chứa messages cũ với system prompt CŨ ghi "Model: gemini/..."
4. Agent context = system prompt MỚI + history CŨ → agent thấy **2 model khác nhau** và có thể trả lời sai

### Giải pháp

Có 2 approach, recommend cả 2:

#### 9A. Inject model reminder vào system prompt (simple, high-impact)

Trong `buildAgentSystemPromptAppend()`, thêm đoạn cuối:

```typescript
// Sau tất cả sections khác:
if (runtimeInfo?.model) {
  parts.push(`\n**IMPORTANT**: You are currently running on model \`${runtimeInfo.model}\`. If the user asks what model you are using, ALWAYS answer with this model, regardless of what appears in earlier conversation history. Model may have been switched mid-session.`);
}
```

**File**: `src/agents/system-prompt.ts` — cuối function `buildAgentSystemPromptAppend()`

Tại sao effective: System prompt là instruction ưu tiên cao nhất — agent sẽ follow system prompt instruction hơn history context.

#### 9B. Ghi model change vào session transcript (optional, nice-to-have)

**Quan trọng**: `readSessionMessages()` (server.ts:730) chỉ đọc entries có `.message` field. Entries khác (như `type: "session"`, `type: "model_change"`) bị skip tự nhiên. Nên nếu muốn agent và history reader thấy model change, phải ghi dưới dạng **message entry**.

**File**: `src/gateway/server.ts` — trong `sessions.patch` handler, sau `saveSessionStore()`:

```typescript
// Sau line 2499: await saveSessionStore(storePath, store);
if ("modelOverride" in p && p.modelOverride !== null && next.model) {
  // Ghi model change vào session transcript dưới dạng message entry
  // (readSessionMessages() chỉ đọc entries có .message field)
  const candidates = resolveSessionTranscriptCandidates(
    existing?.sessionId ?? next.sessionId, storePath
  );
  const transcriptFile = candidates.find((c) => fs.existsSync(c));
  if (transcriptFile) {
    const entry = {
      type: "message",
      message: {
        role: "user",
        content: `[System notification: Model switched to ${next.model}]`,
      },
      parentId: null,
      timestamp: new Date().toISOString(),
    };
    try {
      fs.appendFileSync(transcriptFile, `${JSON.stringify(entry)}\n`, "utf-8");
    } catch { /* non-critical */ }
  }
}
```

**Lưu ý**:
- Entry PHẢI có `.message` field để `readSessionMessages()` pick up
- Dùng `role: "user"` với prefix `[System notification:]` — agent sẽ hiểu đây là thông báo hệ thống
- Không ảnh hưởng compaction — compactor xử lý user/assistant messages bình thường
- **Không bắt buộc** — FIX 9A đã đủ để agent trả lời đúng model. 9B chỉ để history đẹp hơn
- **Khi tạo session mới / channel mới**: JSONL trống, không có marker → sạch, không vấn đề

### Recommend

**FIX 9A trước** — chỉ sửa 1 file (`system-prompt.ts`), 3 dòng, hiệu quả ngay. Agent sẽ luôn trả lời đúng model vì system prompt instruction override history.

**FIX 9B sau** — tốt hơn cho UX (history reflect model change), nhưng phức tạp hơn.

### Test

1. Đổi model qua footer dropdown (ví dụ từ gemini → anthropic-glm47)
2. Hỏi agent "bạn đang dùng model gì?"
3. Agent phải trả lời model MỚI (anthropic-glm47), không phải model cũ

---

## FIX 10: `/new` không tạo session mới trên Sessions page — chỉ reset in-place

### Problem

Khi gõ `/new` trên WebUI chat, Sessions page vẫn chỉ hiển thị 1 "WebUI Chat". Không tạo thêm session card mới.

### Root Cause

`sessions.reset` handler (server.ts:2534) **thay thế entry tại cùng key** — tạo `sessionId` mới nhưng **ghi đè `store[key]`** với `key = "webui"`:

```typescript
const next: SessionEntry = {
  sessionId: randomUUID(),  // sessionId mới
  updatedAt: now,
  // ... copy settings từ entry cũ
};
store[key] = next;  // ← ghi đè key "webui" — KHÔNG tạo key mới
```

Kết quả: `sessions.json` vẫn chỉ có 1 entry `"webui"`, chỉ `sessionId` bên trong thay đổi. Transcript JSONL cũ bị orphan (vì sessionId mới), nhưng không có entry mới trên Sessions page.

### Design hiện tại vs mong muốn

**Hiện tại**: 1 key per surface (`"webui"`, `"telegram"`, `"lark"`). `/new` = reset session tại key đó → history mất, session ID mới, nhưng key giữ nguyên.

**Mong muốn**: Mỗi lần `/new` tạo session riêng, Sessions page hiển thị nhiều sessions cho cùng 1 surface. Ví dụ:
```
WebUI Chat #1  (idle)    gemini-3-flash
WebUI Chat #2  (active)  anthropic-glm47
WebUI Chat #3  (idle)    deepseek-reasoner
```

### Giải pháp

Thay đổi `sessions.reset` để **tạo key mới** thay vì ghi đè key cũ. Key mới dùng format `webui:<sessionId>` hoặc `webui:<timestamp>`.

#### 10A. Backend — `sessions.reset` handler

**File**: `src/gateway/server.ts` — line ~2532

```typescript
case "sessions.reset": {
  // ...validate...
  const p = params as SessionsResetParams;
  const key = String(p.key ?? "").trim();

  const { storePath, store, entry } = loadSessionEntry(key);
  const now = Date.now();
  const newSessionId = randomUUID();

  // Tạo key mới cho session mới (giữ session cũ trong store)
  // Format: "webui:timestamp" hoặc reuse key nếu đã có suffix
  const baseKey = key.split(":")[0]; // "webui" từ "webui" hoặc "webui:xxx"
  const newKey = `${baseKey}:${now}`;

  const next: SessionEntry = {
    sessionId: newSessionId,
    updatedAt: now,
    systemSent: false,
    abortedLastRun: false,
    // Inherit settings từ session cũ
    thinkingLevel: entry?.thinkingLevel,
    verboseLevel: entry?.verboseLevel,
    model: entry?.model,
    contextTokens: entry?.contextTokens,
    surface: entry?.surface ?? baseKey,
    displayName: undefined, // auto-generate
    chatType: entry?.chatType,
  };

  // Cập nhật store: giữ entry cũ, thêm entry mới, xóa pointer key cũ
  // Key cũ ("webui") sẽ trở thành alias → point tới key mới
  store[newKey] = next;
  // Key gốc ("webui") giờ point tới session mới nhất
  store[key] = next;

  await saveSessionStore(storePath, store);
  return {
    ok: true,
    payloadJSON: JSON.stringify({ ok: true, key: newKey, entry: next }),
  };
}
```

**Vấn đề**: approach trên sẽ duplicate entry (cả `"webui"` và `"webui:xxx"` point tới cùng object). Cần approach khác.

#### 10A (revised). Approach đơn giản hơn — rename key cũ, tạo key mới

```typescript
case "sessions.reset": {
  // ...validate...
  const { storePath, store, entry } = loadSessionEntry(key);
  const now = Date.now();

  // Archive session cũ: rename key → "webui:archived:<sessionId>"
  if (entry) {
    const archiveKey = `${key}:${entry.sessionId.slice(0, 8)}`;
    store[archiveKey] = { ...entry };
    // Set displayName cho archive nếu chưa có
    if (!store[archiveKey].displayName) {
      const ts = new Date(entry.updatedAt).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      store[archiveKey].displayName = `WebUI Chat (${ts})`;
    }
  }

  // Tạo session mới tại key gốc ("webui")
  const next: SessionEntry = {
    sessionId: randomUUID(),
    updatedAt: now,
    systemSent: false,
    abortedLastRun: false,
    thinkingLevel: entry?.thinkingLevel,
    verboseLevel: entry?.verboseLevel,
    model: entry?.model,
    contextTokens: entry?.contextTokens,
    surface: entry?.surface,
    chatType: entry?.chatType,
  };
  store[key] = next;

  await saveSessionStore(storePath, store);
  return {
    ok: true,
    payloadJSON: JSON.stringify({ ok: true, key, entry: next }),
  };
}
```

Sau khi `/new`:
```json
{
  "webui:85e46e25": {  // archived session cũ
    "sessionId": "85e46e25-...",
    "displayName": "WebUI Chat (11/03, 23:26)",
    ...
  },
  "webui": {  // session mới (active)
    "sessionId": "new-uuid-...",
    ...
  }
}
```

#### 10B. Frontend — chat.js `/new` handler

Sau khi reset thành công, reload session list:

```javascript
case '/new':
  if (self.currentAgent) {
    OpenFangAPI.post('/api/sessions/' + self.currentAgent.id + '/reset', {}).then(function(resp) {
      self.messages = [];
      // Reload current agent to pick up new sessionId
      self.loadSession(self.currentAgent.id);
      OpenFangToast.success('New session created');
    }).catch(function(e) { OpenFangToast.error('Reset failed: ' + e.message); });
  }
  break;
```

#### 10C. Sessions page — hiển thị archived sessions

Sessions page đã dùng `sessions.list` + `listSessionsFromStore()` → archived sessions (key `webui:85e46e25`) sẽ tự xuất hiện vì chúng là entries trong store.

**Cần kiểm tra**: `classifySessionKey()` và `parseGroupKey()` có handle key format `webui:xxx` đúng không → nếu không thì cần update.

#### 10D. Clickable archived sessions

Sessions page cần cho phép click vào archived session → load history. Hiện tại UI gọi `loadSession(agentId)` — cần thêm param `sessionKey` để load đúng session:

```javascript
// Khi click session card:
self.currentAgent = {
  id: session.key,  // "webui:85e46e25"
  name: session.displayName,
  model: session.model,
  ...
};
self.loadSession(session.key);
```

### Lưu ý quan trọng

- **Transcript file**: Session transcript dùng `sessionId` làm filename (`85e46e25-....jsonl`). Archive session giữ `sessionId` cũ → transcript cũ vẫn đọc được.
- **Session mới**: `sessionId` mới → transcript file mới → history trống (đúng behavior).
- **classifySessionKey()** và **parseGroupKey()**: Cần handle key format `surface:suffix` — verify trước khi implement.
- **Memory**: Có thể limit số archived sessions (ví dụ max 10 per surface) để tránh bloat sessions.json.

### Test

1. Ở WebUI chat, gõ `/new`
2. Sessions page → phải thấy 2 cards: "WebUI Chat (11/03, 23:26)" (archived) + "WebUI Chat" (active)
3. Click archived session → load history cũ
4. Click active session → history trống
5. Gửi message ở active session → hoạt động bình thường

### Complexity

Trung bình — cần sửa backend (`sessions.reset`), verify frontend Sessions page, có thể cần sửa `classifySessionKey()`.

---

## Checklist sau khi fix

- [ ] `pnpm build` passes
- [ ] `pnpm lint` passes
- [ ] Test: message đầu tiên session mới được lưu
- [ ] Test: `/model` hiển thị đúng model
- [ ] Test: đổi model WebUI không ảnh hưởng Telegram
- [ ] Test: đổi default Settings không cascade
- [ ] Test: session mới inherit default model
- [ ] Test: backward compat sessions.json cũ (có modelOverride)
- [ ] Test: agent trả lời đúng khi hỏi "đang dùng model gì?"
- [x] Test: model-switch message hiển thị trong chat khi đổi model ✅
- [x] Test: footer model selector dropdown hoạt động (search, filter, select) ✅
- [x] Test: Ctrl+M mở model selector ✅
- [x] Test: model hiện tại có checkmark trong dropdown ✅
- [ ] Test: `/new` tạo session mới (archived + active) trên Sessions page
- [ ] Test: click archived session → load history cũ
- [ ] Test: agent trả lời đúng model sau khi đổi giữa session (FIX 9)
