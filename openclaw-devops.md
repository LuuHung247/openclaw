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
