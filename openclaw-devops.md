# OpenClaw — Tổng hợp cho DevOps

## 1. OpenClaw là gì?

OpenClaw là open-source autonomous AI assistant chạy trên máy local.
Tự mô tả: _"The AI That Actually Does Things"_ — thực thi task thay vì chỉ gợi ý.

### Architecture

| Component   | Vai trò                                                   |
| ----------- | --------------------------------------------------------- |
| **Gateway** | Kết nối Telegram, Discord, Slack, WhatsApp, Signal...     |
| **Brain**   | LLM reasoning — hỗ trợ Claude, GPT, Ollama (local)        |
| **Sandbox** | Docker container — chạy commands an toàn, cô lập với host |
| **Skills**  | Tools viết bằng JS/TS để mở rộng chức năng                |

### Yêu cầu cài đặt

- Node.js 22+
- Docker
- API key (Anthropic / OpenAI) hoặc Ollama local

---

## 2. Điểm mạnh phù hợp DevOps

- Chạy `kubectl`, `helm`, `terraform`, `docker` commands
- Analyze production logs theo time window
- Review IaC code cho security issues
- Automate deployment scaffolding
- Kubernetes cluster setup & microservice deployment
- Database query optimization
- Security auditing & vulnerability remediation
- 100+ AgentSkills có sẵn từ community (ClawHub)
- Model-agnostic — dùng local model nếu cần air-gap

---

## 3. Vấn đề & Hạn chế

### Bảo mật — Nghiêm trọng

| CVE / Vấn đề                        | Mức độ   | Chi tiết                                                   |
| ----------------------------------- | -------- | ---------------------------------------------------------- |
| CVE-2026-25253                      | CVSS 8.8 | One-click RCE — click link độc hại là bị chiếm quyền agent |
| 135,000+ instances lộ trên internet | Critical | Leak API keys, chat history, credentials                   |
| Malicious Skills trên ClawHub       | High     | 341/2,857 skills là malware (chiến dịch "ClawHavoc")       |
| Command injection vulnerabilities   | High     | 5 security advisories trong chưa đầy 1 tuần                |

### Reliability

- Có thể báo cáo **success khi chưa hoàn thành task** — nguy hiểm trong prod
- **Context compaction bug** — mất instruction giữa chừng, dẫn đến hành động sai (ví dụ: xóa hàng loạt email)
- Third-party app updates có thể làm hệ thống ngừng hoạt động

### Rủi ro vận hành

- Chạy với quyền rộng + lệnh mơ hồ → có thể xóa/ghi đè dữ liệu quan trọng
- Không có enterprise governance tooling
- **Gartner**: _"unacceptable cybersecurity risk for most users"_
- Dùng Anthropic consumer subscription với agent → có thể bị **ban account** (vi phạm ToS)

---

## 4. Customization Log (DevOps Edition)

### Mục tiêu
Chạy trên Linux server (Ubuntu), loại bỏ tất cả chức năng không cần thiết cho DevOps.

### Đã xóa — macOS / iOS specific

| Module | Lý do |
|--------|-------|
| `src/macos/` | macOS app daemon/relay — không dùng trên Linux |
| `src/imessage/` | iMessage (macOS only) |
| `src/canvas-host/` | Canvas + A2UI (iOS/macOS visual surface) |

**Các file liên quan đã được clean:** `gateway/server.ts`, `infra/heartbeat-runner.ts`, `cli/deps.ts`, `config/config.ts`, `config/sessions.ts`, `cron/types.ts`, `cron/isolated-agent.ts`, `commands/agent.ts`, `commands/send.ts`, `gateway/hooks-mapping.ts`

Build status: ✅ clean sau khi xóa

### Đã xóa — Signal messenger

| Module | Lý do |
|--------|-------|
| `src/signal/` | Signal messenger — không dùng trong DevOps |
| `src/commands/signal-install.ts` | Command cài signal-cli |

Build status: ✅ clean sau khi xóa

### Đã xóa — Web UI

| Module | Lý do |
|--------|-------|
| `ui/` | WebChat frontend (Vite app) — dùng Telegram/Lark thay thế |
| `src/gateway/control-ui.ts` | HTTP handler serve WebChat assets |

**Scripts đã xóa khỏi package.json:** `ui:install`, `ui:dev`, `ui:build`

Build status: ✅ clean sau khi xóa

### Đã xóa — Skills nhóm 1 (macOS/iOS only)

`apple-notes`, `apple-reminders`, `things-mac`, `peekaboo`, `imsg`, `camsnap`, `sag`, `eightctl`, `openhue`, `blucli`, `sonoscli`, `spotify-player`

### Đã xóa — Skills nhóm 2 (Social/Messaging)

`discord`, `wacli`, `bird`

### Đã xóa — Skills nhóm 3 (Food/Location)

`food-order`, `ordercli`, `goplaces`, `local-places`

### Đã xóa — Skills nhóm 4 (AI/Image/Audio generation)

`nano-banana-pro`, `openai-image-gen`, `openai-whisper`, `openai-whisper-api`, `gemini`, `songsee`, `gifgrep`

### Đã xóa — Skills lẻ (không liên quan DevOps)

`weather`, `obsidian`, `video-frames`, `trello`

### Đã xóa — Discord channel

| Module | Lý do |
|--------|-------|
| `src/discord/` | Discord channel — chỉ giữ Telegram |

**Các file liên quan đã được clean:** `gateway/server.ts`, `infra/heartbeat-runner.ts`, `agents/clawdis-tools.ts`, `commands/health.ts`, `cli/deps.ts`

Build status: ✅ clean sau khi xóa

### Đã xóa — WhatsApp / Web provider

| Module | Lý do |
|--------|-------|
| `src/web/` | WhatsApp web provider (Baileys) |
| `src/provider-web.ts` | Barrel export cho web provider |
| `src/provider-web.barrel.test.ts` | Test cho barrel đã xóa |

**Các file liên quan đã được clean:** `index.ts`, `cli/program.ts`, `cli/deps.ts`, `commands/health.ts`, `commands/status.ts`, `commands/onboard-providers.ts`, `infra/heartbeat-runner.ts`, `infra/provider-summary.ts`, `agents/pi-tools.ts`, `gateway/server.ts`, `telegram/bot.ts`, `telegram/send.ts`, `auto-reply/reply.ts`

**Bonus:** Thêm `normaliseChannel()` trong `server.ts` — map legacy `"whatsapp"`, `"discord"`, `"webchat"` → `"telegram"` để session cũ không bị lỗi routing.

Build status: ✅ clean sau khi xóa

### Đã xóa — system-prompt.ts tool references (stale)

Xóa khỏi Tooling section trong `src/agents/system-prompt.ts`:
- `whatsapp_login` — WhatsApp đã xóa
- `clawdis_canvas` — canvas-host đã xóa
- `clawdis_nodes` — iOS/macOS nodes đã xóa

### Đã xóa — Test broken (pre-existing)

Xóa 2 test trong `src/gateway/server.test.ts`:
- `"hello-ok advertises the gateway port for canvas host"` — test cho canvas-host đã xóa
- `"agent events stream to webchat clients when run context is registered"` — test cho webchat đã xóa

### Thêm mới — Dashboard UI (từ openfang)

Port toàn bộ UI của openfang sang openclaw:

| Thứ | Chi tiết |
|-----|----------|
| `ui/` | Static assets (Alpine.js SPA, CSS, vendor libs) copy từ openfang |
| `ui/js/api.js` | Rewrite hoàn toàn — giao tiếp qua Gateway WebSocket thay vì REST |
| `src/gateway/server.ts` | Thêm `handleUiRequest()` — serve `/ui/*` và redirect `/` → index |

**Pages giữ lại (DevOps):** Chat, Overview, Sessions, Approvals, Logs, Scheduler, Workflows, Channels, Skills, Analytics, Settings

**Pages đã bỏ:** Hands, Comms, Wizard (openfang-specific)

Truy cập sau khi gateway chạy: `http://localhost:18789/ui`

---

## 5. Chạy local (dev)

> **Không dùng Docker cho local dev nữa.** Onboard hoàn toàn qua Web UI.

### Bước 1 — Tạo workspace

```bash
mkdir -p ~/.clawdis ~/clawd
```

`~/.clawdis/clawdis.json` tối thiểu (auth off, bind lan):

```json
{
  "agent": { "workspace": "/home/<user>/clawd" },
  "gateway": {
    "mode": "local",
    "bind": "lan",
    "auth": { "mode": "none" }
  },
  "skills": { "install": { "nodeManager": "npm" } }
}
```

### Bước 2 — Start gateway

```bash
pnpm start gateway
```

### Bước 3 — Onboard qua Web UI

Mở browser: `http://localhost:18789/ui`

- **Channels** → Telegram → nhập bot token → Save
- **Settings** → chọn model provider + API key
- Không cần chạy `pnpm onboard` hay `docker compose run --rm clawdis-cli onboard` nữa

### Stop

`Ctrl+C` trong terminal.

### Ports

| Port | Dùng cho |
|------|----------|
| `18789` | Gateway WebSocket + Dashboard UI (`/ui`) |
| `18790` | Bridge (node pairing, có thể bỏ qua) |
| `18791` | Browser control (local only) |

---

## 6. Phân tích Lỗi Migrate (UI từ openfang → openclaw)

> **Ngày:** 2026-03-02  
> **Tình trạng:** ✅ Fixed  
> **Root cause:** openfang là Rust REST API backend, openclaw là Node.js WebSocket gateway — API contract hoàn toàn khác nhau. UI copy từ openfang nhưng `api.js` phải bridge sang WebSocket protocol của openclaw.

---

### Bug #1 — `getAgents()` thiếu field `state` (CRITICAL)

**File:** `ui/js/api.js` — function `getAgents()`  
**Ảnh hưởng:** Toàn bộ Agents page crash/blank vì `agent.state` = undefined  
**Root cause:** openfang trả về `state: "Running"|"Idle"`, nhưng openclaw `getAgents()` chỉ map `status: "idle"|"error"` và thiếu `model_provider`, `model_name`, `identity`

**Fix:**
```js
// Trước (broken)
return { id, name, status: ..., provider: ... };

// Sau (fixed)
var state = s.running ? 'Running' : (s.abortedLastRun ? 'Error' : 'Idle');
return { id, name, state, status, model_provider, model_name, identity: {} };
```

---

### Bug #2 — `saveProviderKey()` override toàn bộ providers config (HIGH)

**File:** `ui/js/api.js` — POST `/api/providers/{id}/key`  
**Ảnh hưởng:** Save key provider A xóa keys của providers B, C, D  
**Root cause:** `config.set` với `{ providers: { anthropic: { apiKey: '...' } } }` override toàn bộ providers object thay vì merge

**Fix:**
```js
// Trước (broken)
request('config.set', { patch: { providers: { [provId]: { apiKey } } } })

// Sau (fixed) — nested path để gateway biết là partial update
request('config.set', { patch: { models: { providers: { [provId]: { apiKey } } } } })
```

---

### Bug #3 — `removeProviderKey()` set empty string thay vì null (MEDIUM)

**File:** `ui/js/api.js` — DEL `/api/providers/{id}/key`  
**Ảnh hưởng:** Provider vẫn hiển thị "configured" sau khi xóa key  
**Fix:** Set `apiKey: null` thay vì `apiKey: ''`

---

### Bug #4 — `getChannels()` không hiển thị Telegram khi chưa config (MEDIUM)

**File:** `ui/js/api.js` — function `getChannels()`  
**Ảnh hưởng:** Channels page trống hoàn toàn → user không biết cách configure Telegram  
**Root cause:** Chỉ push Telegram vào list khi `p.telegram` đã tồn tại (tức là đã configured)

**Fix:** Luôn trả về Telegram channel với `configured: false` nếu chưa setup. Detect qua nhiều field names (`tg.configured || tg.token || tg.botToken || tg.bot_token`)

---

### Bug #5 — `channels.js` gọi `OpenFangAPI.delete()` không tồn tại (HIGH)

**File:** `ui/js/pages/channels.js` line 255  
**Ảnh hưởng:** Click Remove channel → JavaScript runtime error  
**Root cause:** openfang api dùng `.delete()`, openclaw api chỉ export `.del()`

**Fix:** Thay `OpenFangAPI.delete(...)` → `OpenFangAPI.del(...)`

---

### Bug #6 — `/api/migrate/detect` endpoint không tồn tại → Settings crash (MEDIUM)

**File:** `ui/js/api.js` — GET shim  
**Ảnh hưởng:** Khi user click tab "Migration" trong Settings, page crash vì request unmapped  
**Fix:** Thêm handler trả về `{ detected: false }` gracefully

---

### Bug #7 — `/new` và `/compact` slash commands gọi sai endpoint (MEDIUM)

**File:** `ui/js/pages/chat.js`  
**Ảnh hưởng:** `/new` và `/compact` trong chat box không hoạt động  
**Root cause:** Chat.js dùng openfang REST path `/api/agents/{id}/session/reset` nhưng openclaw api shim chỉ handle `/api/sessions/{key}/reset`

**Fix:**
```js
// Trước (openfang path)
OpenFangAPI.post('/api/agents/' + id + '/session/reset', {})
// Sau (openclaw shim path)
OpenFangAPI.post('/api/sessions/' + id + '/reset', {})
```

---

### Bug #8 — `testProvider()` không pass provider ID (LOW)

**File:** `ui/js/api.js` — POST `/api/providers/{id}/test`  
**Ảnh hưởng:** Test button luôn test toàn bộ thay vì provider cụ thể  
**Fix:** Truyền `provider: provId` vào `providers.status` request

---

### Tổng kết các file đã sửa

| File | Lỗi đã fix |
|------|-----------|
| `ui/js/api.js` | Bug #1 getAgents state, #2 saveProviderKey merge, #3 removeProviderKey null, #4 getChannels always show, #6 migrate endpoints, #8 testProvider ID |
| `ui/js/pages/channels.js` | Bug #5 `.delete()` → `.del()` |
| `ui/js/pages/chat.js` | Bug #7 `/new` `/compact` correct endpoint paths |

---

### Sự khác biệt kiến trúc openfang vs openclaw (để tránh lỗi tương lai)

| Aspect | openfang (Rust) | openclaw (Node.js) |
|--------|----------------|-------------------|
| Protocol | REST HTTP API | WebSocket JSON-RPC |
| Agent concept | `agent_id` UUID | `sessionKey` string |
| Agent fields | `state: "Running"` | map từ `running` bool |
| model split | `model_provider` + `model_name` | `model: "provider/name"` string |
| Provider config | REST PUT `/api/providers/{id}/key` | WS `config.set` nested patch |
| Session reset | `/api/agents/{id}/session/reset` | `/api/sessions/{key}/reset` shim |
| Channels | Multi-channel (Telegram, Discord, Slack...) | Telegram only |
| Migration | Native support | Không support (openclaw là target) |
| Identity | `agent.identity.emoji` from DB | `session.identity` từ config |

---

## 8. API Shim — Conflict Resolution (Session 3)

Sau khi explore toàn bộ openfang (60+ REST endpoints, 15 pages) vs openclaw Gateway (70+ WS methods), đã implement các fixes sau trong `ui/js/api.js`:

### 8.1 Agent Spawn (POST /api/agents)

**Trước:** Return stub `{ agent_id: 'main' }` cứng — wizard spawn không có tác dụng gì.

**Sau:** Parse manifest TOML text để lấy `name`, `provider`, `model`, `system_prompt`, rồi gọi `sessions.patch` để tạo session mới với key = slug của tên agent.

```javascript
// Parse từ TOML manifest
var agentName = toml.match(/^name\s*=\s*"([^"]+)"/m);
var sessionKey = agentName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
request('sessions.patch', { key: sessionKey, displayName: agentName });
```

> **Lưu ý:** Gateway `sessions.patch` không support `model` field trực tiếp. Model được set qua `config.set { agent: { model } }` — áp dụng globally cho tất cả sessions.

### 8.2 Model Selector (PUT /api/agents/{id}/model)

**Trước:** Dùng `sessions.patch` với `model` field — không hoạt động vì Gateway không accept field này.

**Sau:** Dùng `config.set` với `patch: { agent: { model } }` — set default model cho toàn bộ gateway.

Chat page `/model` command và model picker đều hoạt động. Field `available: true` được thêm vào tất cả models từ `models.list` (Gateway chỉ trả về models có key).

### 8.3 In-Memory KV Store (Sessions page)

Gateway không có session-level KV endpoint. Implement `_kvStore` backed bởi `localStorage`:

```javascript
var _kvStore = (function() {
  // Persist to localStorage key 'openclaw-kv-store'
  // Per-agent namespacing: _data[agentId][key] = value
})();
```

- `GET /api/memory/agents/{id}/kv` → `_kvStore.list(agentId)`
- `PUT /api/memory/agents/{id}/kv/{key}` → `_kvStore.set(agentId, key, value)`
- `DELETE /api/memory/agents/{id}/kv/{key}` → `_kvStore.del(agentId, key)`

Ngoài ra KV store được dùng để lưu identity (emoji, color, archetype, vibe) và system_prompt của agents.

### 8.4 In-Memory Trigger Store (Scheduler page)

Gateway không có trigger concept. Implement `_triggers` array in-memory:

- `GET /api/triggers` → list triggers
- `POST /api/triggers` → tạo trigger mới
- `PUT /api/triggers/{id}` → update trigger
- `DELETE /api/triggers/{id}` → xóa trigger

Triggers chỉ tồn tại trong session browser — không persist qua page reload (khác cron jobs được lưu trong gateway).

### 8.5 In-Memory Workflow Store

Tương tự triggers, workflow DAG được lưu in-memory. Khi run workflow, step đầu tiên có `message` field sẽ được gửi như một agent message.

### 8.6 Agent Config PATCH (/api/agents/{id}/config)

`PATCH /api/agents/{id}/config` từ agents page gửi `{ emoji, color, archetype, vibe, name, model }`:

| Field | Xử lý |
|-------|-------|
| `name` | `sessions.patch { displayName }` |
| `model` | `config.set { agent: { model } }` |
| `system_prompt` | Lưu vào KV store (`__system_prompt__`) |
| `emoji`, `color`, `archetype`, `vibe` | Lưu vào KV store (`__identity_{field}__`) |

### 8.7 MCP Servers & Tools

- `GET /api/mcp/servers` → filter từ skills có "mcp" hoặc "server" trong tên
- `GET /api/tools` → **fix**: trước đây chỉ hiện skills có `tools_count > 0` (luôn là 0), nay hiện tất cả `eligible` skills vì mỗi skill expose ít nhất 1 tool

### 8.8 Danh sách đầy đủ endpoints đã implement

| Method | Path | Gateway | Ghi chú |
|--------|------|---------|---------|
| GET | `/api/triggers` | In-memory | Mới |
| POST | `/api/triggers` | In-memory | Mới |
| PUT | `/api/triggers/{id}` | In-memory | Mới |
| DELETE | `/api/triggers/{id}` | In-memory | Mới |
| GET | `/api/workflows` | In-memory | Mới |
| POST | `/api/workflows` | In-memory | Mới |
| PUT | `/api/workflows/{id}` | In-memory | Mới |
| POST | `/api/workflows/{id}/run` | Sends first step as message | Mới |
| GET | `/api/memory/agents/{id}/kv` | localStorage KV | Mới |
| PUT | `/api/memory/agents/{id}/kv/{key}` | localStorage KV | Mới |
| DELETE | `/api/memory/agents/{id}/kv/{key}` | localStorage KV | Mới |
| POST | `/api/agents` | `sessions.patch` | Fix: tạo session thực |
| POST | `/api/agents/{id}/clone` | `sessions.patch` new key | Fix |
| PUT | `/api/agents/{id}/model` | `config.set` | Fix: dùng config.set thay sessions.patch |
| PATCH | `/api/agents/{id}/config` | Multi-dispatch | Fix: name/model/identity/soul |
| GET | `/api/models` | `models.list` + `available:true` | Fix: thêm available field |
| GET | `/api/mcp/servers` | Derived từ skills | Fix: filter skill names |
| GET | `/api/tools` | All eligible skills | Fix: bỏ tools_count filter |

### 8.9 Build lại Docker

```bash
cd /path/to/openclaw
docker build --no-cache -t clawdis:local .
docker compose down && docker compose up -d clawdis-gateway
```

Quick update (không rebuild):
```bash
docker cp ui/js/api.js <container>:/app/ui/js/api.js
```

---

## 9. WebUI Chat — Session Isolation & Streaming Fix (Session 4)

### Vấn đề ban đầu

Chat trên WebUI hoàn toàn không hoạt động — gửi message không nhận được response.

### Root Cause phân tích

| # | Bug | Root cause |
|---|-----|-----------|
| 1 | Gửi message không đến gateway | `_sendPayload` gửi raw `{type:'message', content}` qua WS — gateway không hiểu, chỉ accept JSON-RPC `{type:'req', method, params}` |
| 2 | Event routing sai type | Event router wrap payload thành `{type:'agent', payload}` nhưng `handleWsMessage` switch trên `text_delta`, `response`, etc. — không có case `agent` |
| 3 | Delta text bị duplicate trong bubble | Gateway gửi **cumulative** text mỗi delta (không phải incremental) — nếu append trực tiếp sẽ bị "HelloHello world" |
| 4 | `OpenFangAPI.request` không được expose | Internal `request()` function chưa export ra public API object |
| 5 | Tin nhắn duplicate (2 bubbles) | Gateway emit 2x `broadcast("chat", state:final)` per run: một từ `chatLink` branch (dùng `idempotencyKey` làm runId), một từ `else` branch (dùng `sessionId`) → 2 `response` events |
| 6 | WebUI nhận message của Telegram | `_agentEventListeners['main']` là fallback → nhận **mọi** chat event của session `main` kể cả Telegram |

### Fixes đã implement

**`ui/js/api.js`:**

1. **Expose `request()`** — thêm `request: request` vào object return của `OpenFangAPI`

2. **Event router mới** — lắng nghe `chat` events (không phải `agent`), translate sang format chat.js hiểu:
   - `state: 'delta'` → tính incremental diff → `{type: 'text_delta', content: delta}`
   - `state: 'final'` → `{type: 'response', content: fullText}`
   - `state: 'error/aborted'` → `{type: 'error', message}`
   - Track `_chatRunText[runId]` để compute delta từ cumulative text

3. **Dedup final events** — track `_sessionFinalSeq[sid]`: nếu nhận `final/error/aborted` với seq đã xử lý rồi thì skip (gateway gửi 2 broadcasts cùng seq)

4. **Bỏ cross-session fallback** — `_agentEventListeners[sid]` only, không `|| _agentEventListeners['main']`

5. **Session display** — `getAgents()` thêm `channel` field, inject `webui` session luôn dù chưa chat, tên đẹp: `main` → "Telegram", `webui` → "WebUI Chat"

**`ui/js/pages/chat.js`:**

6. **`_sendPayload` dùng `chat.send` RPC** thay vì raw `wsSend`:
   ```js
   await OpenFangAPI.request('chat.send', {
     sessionKey, message, idempotencyKey, thinking, timeoutMs: 30000
   }, 600000);
   // chat.send blocks until agent run completes; 'chat' events stream in the meantime
   ```

7. **`autoLoadAgent` dùng session `webui`** — không lấy `agents[0]` (session `main` của Telegram):
   ```js
   var webuiAgent = { id: 'webui', name: 'WebUI Chat', ... };
   this.selectAgent(webuiAgent);
   ```

**`ui/js/pages/agents.js`:**

8. **`chatWithAgent` redirect** — click session `webui` → navigate sang tab Chat thay vì mở inline

### Gateway chat event format (tham khảo)

```
chat event {
  state: "delta" | "final" | "error" | "aborted",
  sessionKey: string,
  runId: string,       // idempotencyKey (chatLink branch) hoặc sessionId (else branch)
  seq: number,         // cùng seq cho cả 2 broadcasts — dùng để dedup
  message?: {
    role: "assistant",
    content: [{ type: "text", text: string }]  // cumulative text ở delta
  },
  errorMessage?: string
}
```

### Còn tồn đọng ⚠️

- **Duplicate vẫn có thể xảy ra** nếu 2 `final` broadcasts có `seq = 0` (fallback khi seq không có) — cần monitor thêm
- **`0 in / 0 out`** trong message meta — `chat.send` không trả về token count; cần lấy từ `agent` event usage nếu muốn hiển thị đúng
- **History load**: `loadSession` dùng `chat.history` RPC, format message từ Pi runtime transcript (JSONL) — cần verify khi có nhiều tool calls

---

## 10. Chat UI & Telegram Channel Config Fix (Session 5)

> **Ngày:** 2026-03-03 → 2026-03-04
> **Trạng thái:** ✅ Fixed & committed (`35109ee6a` trên branch `osp-devop-custome`)

### Bug #9 — Message role case-sensitive → user message hiển thị sai bên (MEDIUM)

**File:** `ui/js/pages/chat.js` dòng 425
**Ảnh hưởng:** Sau khi reload trang, messages của user hiển thị bên trái (như model) thay vì bên phải
**Root cause:** So sánh `m.role === 'User'` là case-sensitive, nhưng gateway trả về `'user'` lowercase

**Fix:**
```js
// Trước (broken)
var role = m.role === 'User' ? 'user' : (m.role === 'System' ? 'system' : 'agent');

// Sau (fixed)
var roleStr = (m.role || '').toLowerCase();
var role = roleStr === 'user' ? 'user' : (roleStr === 'system' ? 'system' : 'agent');
```

---

### Bug #10 — Telegram channel form không hiển thị ô nhập Bot Token (HIGH)

**File:** `ui/js/api.js` — `getChannels()` function
**Ảnh hưởng:** Click "Edit Config" trên Telegram channel → form trống, không có ô nhập token
**Root cause:** Field được khai báo `type: 'password'` nhưng HTML template trong `channels.js` chỉ render khi `f.type === 'secret'`

```html
<!-- channels.js chỉ handle type='secret', 'text', 'number', 'list' -->
<template x-if="f.type === 'secret'">
  <input type="password" ...>
</template>
```

**Fix:** Đổi `type: 'password'` → `type: 'secret'` trong khai báo field của Telegram channel trong `api.js`

---

### Bug #11 — Đổi token qua Web UI không restart Telegram bot ngay lập tức (HIGH)

**File:** `src/gateway/server.ts` — handler `config.set`
**Ảnh hưởng:** Lưu token mới qua Web UI → file config được cập nhật nhưng bot Telegram vẫn chạy với token cũ
**Root cause:** `config.set` chỉ ghi file, không trigger restart Telegram provider đang chạy trong bộ nhớ

**Fix:** Thêm stop/start Telegram provider sau khi lưu config (cả 2 handler: IPC bridge và WebSocket):
```typescript
await writeConfigFile(validated.config);
await stopTelegramProvider();           // Tắt bot cũ
startTelegramProvider().catch((err) => { // Bật lại với token mới
  logTelegram.error(`config update telegram spawn failed: ${formatError(err)}`);
});
```

---

### Session naming — Tại sao Telegram session tên là `main`?

Theo thiết kế của clawdis (`src/telegram/bot.ts`):
- Mọi tin nhắn DM từ Telegram → được gán vào session key `mainKey` (mặc định: `"main"`)
- Session `main` được dùng chung cho: Telegram DM, heartbeat, cron jobs
- Session `webui` là session riêng cho Web UI chat (isolated)

**Đổi tên Telegram session** (nếu muốn dùng tên khác):
```json
// ~/.clawdis/clawdis.json
{
  "session": {
    "mainKey": "telegram"
  }
}
```
Restart gateway → Telegram DM sẽ dùng session `telegram` thay vì `main`.

> ⚠️ **Lưu ý:** Thay đổi `mainKey` cũng ảnh hưởng đến heartbeat và cron. Nếu chỉ muốn đổi tên hiển thị trong Web UI mà không đổi session logic, có thể sửa mapping trong `getAgents()` của `api.js`.

---

### Cách restart gateway (không có lệnh built-in)

```bash
# Tìm và kill process đang chiếm cổng 18789
lsof -ti :18789 | xargs kill -9

# Bật lại
npx tsx src/index.ts gateway-daemon --port 18789
```

> `pnpm stop` / `pnpm restart` không tồn tại trong `package.json`. Cách chính thống là `Ctrl+C`.

