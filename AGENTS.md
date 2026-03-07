
# Agent Guidelines — openclaw

## Context

openclaw là DevOps-focused AI agent platform (fork của Clawdis) chạy trên Linux/Ubuntu.
Khi làm việc với codebase này, đọc kỹ file này và `CLAUDE.md` trước khi thay đổi bất cứ thứ gì.

## Platform & Environment

- **OS**: Linux (Ubuntu) — không có macOS, iOS, Swift, launchctl
- **Gateway**: TypeScript WebSocket server, `systemctl --user restart clawdis-gateway.service`
- **Surface**: Telegram only (không có WhatsApp, Discord, iMessage, WebChat)
- **Build**: `pnpm build` (tsc); lint: `pnpm lint` (biome); test: `pnpm test` (vitest)
- **PATH mặc định trong bash-tools**: `/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` — **không có** `/opt/homebrew`

## Coding Principles (theo thứ tự ưu tiên)

### 1. Không Spaghetti Code

- **Mỗi file = một nhiệm vụ**: đừng mix state management + business logic + I/O trong cùng 1 file
- **Extract khi > 700 LOC**: tách thành sub-modules có tên rõ ràng
- **Không inline helpers** mà có thể tái sử dụng → đặt trong file riêng và import

### 2. Pattern Đã Thiết Lập — Tuân Theo

Codebase đã có sẵn các patterns; **dùng lại thay vì tạo mới**:

| Nhu cầu                    | Dùng                                                   |
| --------------------------- | ------------------------------------------------------- |
| WS handler params (string)  | `readStringParam()` từ `agents/tool-params.ts`     |
| Gateway port/URL constant   | `GATEWAY_DEFAULT_*` từ `gateway/constants.ts`      |
| Telegram parse error regex  | `PARSE_ERR_RE` từ `telegram/constants.ts`          |
| Tool descriptions in prompt | `TOOL_DESCRIPTIONS` trong `agents/system-prompt.ts` |
| Gateway mutable state       | `GatewayContext` từ `gateway/gateway-context.ts`   |
| OAuth storage               | `agents/pi-oauth-storage.ts`                          |
| Model/auth resolution       | `agents/pi-model-resolver.ts`                         |
| Usage tracking              | `gateway/usage-log.ts`                                |

### 3. Handler Extraction Pattern

WS switch-case handlers phải được extract sang `src/gateway/handlers/`:

```typescript
// Đúng — trong handlers/my-handlers.ts
export async function handleMyAction(
  params: Record<string, unknown>,
  deps: SomeDeps,
  respond: RespondFn,
): Promise<void> { ... }

// Sai — inline trong server.ts switch block
case "my.action": { /* 50 lines of logic */ }
```

### 4. Type Safety

- **Không dùng `@ts-nocheck`** — fix lỗi thực sự
- Dùng inline structural types khi external package không re-export type (xem `TelegramMessage` trong `bot.ts`)
- Overloads cho conditional return types (xem `readStringParam`)
- `as Type` cast chỉ khi cần, kèm comment lý do

### 5. Error Handling

```typescript
// Silent catch hợp lý (network/cleanup/best-effort)
try { await bonjourStop(); } catch { /* ignore */ }

// Warn khi ảnh hưởng user-facing behavior
try { frontmatter = parseFrontmatter(raw); }
catch (err) { console.warn(`[skills] failed to load "${name}": ${err}`); }

// KHÔNG làm — silent catch che giấu lỗi quan trọng
try { return await runCriticalOperation(); } catch { return null; }
```

### 6. Constants Không Hardcode

```typescript
// Đúng
import { GATEWAY_DEFAULT_WS_URL } from "../gateway/constants.js";

// Sai
const url = "ws://127.0.0.1:18789";
```

## Files Quan Trọng

### Gateway Layer

- `src/gateway/server.ts` — main WS server (~5800 LOC, orchestrator)
- `src/gateway/gateway-context.ts` — tất cả mutable state
- `src/gateway/constants.ts` — GATEWAY_DEFAULT_PORT=18789, WS/HTTP URL
- `src/gateway/handlers/` — cron, skills, usage handlers
- `src/gateway/ws-logging.ts` — logWsWithMaps, shortId, formatForLog

### Agent Runtime

- `src/agents/pi-embedded-runner.ts` — orchestrator only (~370 LOC)
- `src/agents/pi-model-resolver.ts` — resolveModel, getApiKeyForModel
- `src/agents/pi-oauth-storage.ts` — OAuth credential management
- `src/agents/pi-embedded-subscribe.ts` — session event subscription (443 LOC, tight coupling — giữ nguyên)
- `src/agents/tool-params.ts` — readStringParam, readStringArrayParam
- `src/agents/system-prompt.ts` — buildAgentSystemPromptAppend() với dynamic tooling
- `src/agents/bash-tools.ts` — bash/process tools

### Telegram

- `src/telegram/bot.ts` — createTelegramBot, deliverTextReply/deliverMediaReply
- `src/telegram/constants.ts` — PARSE_ERR_RE, TEXT_CHUNK_LIMIT
- `src/telegram/send.ts` — sendMessageTelegram
- `src/telegram/proxy.ts` — makeProxyFetch

### Memory & Storage

- `src/memory/sqlite.ts` — SQLite memory substrate (BM25 + vector recall)
- `src/gateway/usage-log.ts` — token usage JSONL log

## System Prompt Identity

Agent identity là **"openclaw"** — không phải "Clawd" hay "Clawdis".
Khi sửa `buildAgentSystemPromptAppend()`, giữ nguyên:

- `activeTools` param → dynamic tooling section
- `TOOL_DESCRIPTIONS` map → canonical descriptions
- Identity string "openclaw"

## Những Thứ Đã Bị Xóa (đừng thêm lại)

- macOS/iOS: `src/macos/`, `src/imessage/`, Swift code
- Signal, Discord, WhatsApp, WebChat providers
- Web UI (`ui/` Vite app)
- macOS-only skills: apple-notes, peekaboo, camsnap, spotify-player, v.v.
- Hardcoded `/opt/homebrew/bin` trong PATH

## Reset Workspace

Script `scripts/reset-workspace.sh` — dùng khi cần reset agent state. Templates nằm ở `docs/templates/`.

| Mode | Tác dụng |
|------|----------|
| `--conversations` | Xóa sessions + usage log + media. Giữ identity, memory, cron. |
| `--soft` | Overwrite AGENTS/SOUL/TOOLS từ template. Giữ identity + memory + `~/.clawdis/`. |
| `--full` | Factory reset. Require gõ `yes`. Giữ `clawdis.json`, `credentials/`, `skills/`. |

**Những gì KHÔNG bị xóa trong mọi mode:**
- `~/.clawdis/clawdis.json` — provider config, API keys
- `~/.clawdis/credentials/oauth.json` — OAuth tokens
- `~/.clawdis/skills/` — installed skills

**Flow dev khi sửa templates:**
```bash
vim docs/templates/TOOLS.md       # sửa template
./scripts/reset-workspace.sh --soft   # áp dụng lên workspace
systemctl --user restart clawdis-gateway.service
```

**Flow test bootstrap từ đầu:**
```bash
./scripts/reset-workspace.sh --full   # factory reset (gõ 'yes' để confirm)
systemctl --user restart clawdis-gateway.service
# Chat với agent qua Telegram → nó sẽ thấy BOOTSTRAP.md và bắt đầu ritual
```

## Checklist Trước Khi Submit

- [ ] `pnpm build` passes (không có TS errors)
- [ ] `pnpm lint` passes (không có biome warnings)
- [ ] Không có `@ts-nocheck` mới
- [ ] Constants dùng từ `constants.ts`, không hardcode
- [ ] Handler extraction đúng pattern nếu thêm WS handler mới
- [ ] `activeTools` được truyền nếu gọi `buildAgentSystemPromptAppend()`
- [ ] Silent catches có comment lý do hoặc warn nếu cần
