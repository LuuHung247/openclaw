# Openclaw Refactor Plan

## Tong quan hien trang

| Module | LOC | File lon nhat | Van de chinh |
|--------|-----|---------------|--------------|
| Gateway | ~7000 | server.ts (6555 LOC) | Monolithic function 5244 dong |
| Agents/Pi-embedded | ~1960 | bash-tools.ts (1089), clawdis-tools.ts (1571) | Ham qua dai, duplication |
| Telegram | ~900 | bot.ts (486) | @ts-nocheck, code duplication |
| Skills | ~150 | skills.ts | Fragile parsing, silent failures |
| System Prompt | ~111 | system-prompt.ts | Hardcoded tool list |

---

## Phase 1: CRITICAL - Tach server.ts Monolith

**Muc tieu**: Tach `startGatewayServer()` (5244 dong) thanh cac module nho.

### 1.1 Tao Gateway Context class
```
src/gateway/
  gateway-context.ts        # GatewayContext class chua tat ca state (Maps, flags, config)
```
- Gom tat ca mutable state (`presenceVersion`, `healthCache`, `wsInflightSince`, etc.) vao 1 class
- Inject dependencies qua constructor thay vi import truc tiep
- Them cleanup/dispose method cho Maps (tranh memory leak)

### 1.2 Extract Handler Registry
```
src/gateway/
  handlers/
    index.ts                # Handler registry + dispatch logic
    config-handlers.ts      # config.get, config.set, config.list
    health-handlers.ts      # health, health.subscribe
    session-handlers.ts     # session.*, talk.*
    model-handlers.ts       # models.list, models.resolve
    provider-handlers.ts    # provider.*, bridge.*
    cron-handlers.ts        # cron.*
    send-handlers.ts        # send, send.media
    voicewake-handlers.ts   # voicewake.*
```
- Thay switch 60+ cases bang `Record<string, HandlerFn>`
- Moi handler la pure function nhan `(params, ctx: GatewayContext) => Promise<Result>`
- Test tung handler doc lap

### 1.3 Extract WebSocket Layer
```
src/gateway/
  ws-manager.ts             # WebSocket connection lifecycle
  ws-dispatch.ts            # Message routing tu WS -> handlers
```
- Tach WS connection management khoi business logic
- WS message parsing + validation rieng

### 1.4 Extract HTTP Routes
```
src/gateway/
  http-routes.ts            # Express route definitions
```
- Tach HTTP endpoints (bridge, health, webhook) ra file rieng

### 1.5 Consolidate Logging
- Gop `logWs()`, `logWsOptimized()`, `logWsCompact()` thanh 1 ham voi strategy param
- Extract `extractMeta()` + `buildTokens()` helper (xoa ~170 dong duplicate)

**Ket qua**: server.ts con lai chi la bootstrap: khoi tao context, register handlers, start WS + HTTP.

---

## Phase 2: HIGH - Agent Runtime Cleanup

### 2.1 Tach pi-embedded-runner.ts (736 LOC -> 4 file)
```
src/agents/
  pi-session-context.ts     # resolveSessionContext() - model, auth, workspace
  pi-system-prompt.ts       # buildSystemPromptWithContext() - system prompt + memory + skills
  pi-session-loop.ts        # runSessionLoop() - prompt -> subscribe -> abort
  pi-memory-store.ts        # storeSessionMemory() - memory substrate interactions
  pi-embedded-runner.ts     # Con lai chi la orchestrator goi 4 ham tren
```

### 2.2 Tach pi-embedded-subscribe.ts (442 LOC -> classes)
```
src/agents/
  text-accumulator.ts       # TextAccumulator class - deltaBuffer, cumulativeText state
  compaction-state.ts        # CompactionStateMachine class - retry lifecycle
  pi-embedded-subscribe.ts  # Con lai chi la event dispatcher
```

### 2.3 Refactor bash-tools.ts (1089 LOC)
- Tach `createBashTool()` execute handler (182 LOC) thanh:
  - `setupPtySession()`
  - `setupPipeSession()`
  - `formatBashOutput()` (chunking + truncation)
- Fix hardcoded macOS PATH (`/opt/homebrew/bin`) - them Linux PATH

### 2.4 Giam boilerplate trong clawdis-tools.ts
- Extract `readStringParam()` (dung 45+ lan) ra `tool-params.ts`
- Gop `AnyAgentTool` type definition (duplicate o 2 file) vao `types.ts`

---

## Phase 3: MEDIUM - Telegram Type Safety & DRY

### 3.1 Xoa @ts-nocheck
- **bot.ts**: Xoa `@ts-nocheck`, fix tung type error
- **send.ts**: Xoa `@ts-nocheck` (o ca dong 1 VA dong 197), fix types
- **proxy.ts**: Tuong tu
- Day la buoc quan trong nhat cua Phase 3 - @ts-nocheck an tat ca bug

### 3.2 Extract shared constants & helpers
```
src/telegram/
  constants.ts              # PARSE_ERR_RE, TEXT_CHUNK_LIMIT, etc.
  format-helpers.ts         # sendWithMarkdownFallback() - gop logic tu bot.ts + send.ts
```
- `PARSE_ERR_RE` hien tai duplicate o bot.ts:24 va send.ts:20
- Markdown fallback logic duplicate o bot.ts:452-463 va send.ts:159-180

### 3.3 Simplify deliverReplies()
- bot.ts:266-343 (77 dong nested logic)
- Tach thanh `deliverTextReply()` + `deliverMediaReply()`
- Them error collection thay vi throw on first error

---

## Phase 4: MEDIUM - Error Handling & Observability

### 4.1 Xoa silent catch blocks trong gateway
- Them `logDebug()` hoac `logWarn()` cho moi catch block
- Ngoai tru shutdown cleanup (co the giu /* ignore */)
- File: server.ts dong 407, 655, 697, 6490-6538

### 4.2 Cai thien error messages
- pi-embedded-runner.ts:308: Thay "No API key found" bang message co actionable hint
- Phan biet "no credentials" vs "OAuth refresh failed"

### 4.3 Memory substrate error handling
- pi-embedded-runner.ts:452,717: Them retry logic (1 lan) + user notification
- Hien tai silent fail -> mat data ma user ko biet

### 4.4 Extract validation helper
- Gop 30+ repeated validation blocks trong server.ts thanh:
```typescript
function validateOrError<T>(data: unknown, validator: ValidateFn<T>, context: string):
  { ok: true; data: T } | { ok: false; error: ErrorResponse }
```

---

## Phase 5: LOW - Constants & Config Cleanup

### 5.1 Extract magic numbers
```
src/gateway/constants.ts    # WEBSOCKET_MAX_PAYLOAD, ATTACHMENT_MAX_BYTES, TICK_CHECK_INTERVAL, etc.
src/agents/constants.ts     # IMAGE_RESIZE_GRID, MAX_IMAGE_BYTES, ERROR_TRUNCATION_LIMIT, etc.
```

### 5.2 Centralize env var validation
- Hien tai env vars doc rai rac: CLAWDIS_OAUTH_DIR, PI_CODING_AGENT_DIR, PI_BASH_MAX_OUTPUT_CHARS...
- Tao `src/config/env.ts` validate tat ca env vars luc startup
- Log warning neu gia tri ko hop le (thay vi fail luc runtime)

### 5.3 Xoa stale code
- `normaliseChannel()` trong server.ts van map "whatsapp", "discord" -> "telegram"
- Neu chac chan ko con client nao gui channel cu -> xoa va chi giu "telegram"
- Review lai xem con code nao reference den providers da xoa chua

---

## Phase 6: LOW - Skills & System Prompt

### 6.1 Skills loading robustness
- skills.ts:59-83: Them warning log khi ko tim thay bundled skills (hien tai silent)
- Thay regex frontmatter parser bang YAML parser (js-yaml da co trong deps)
- Validate parsed skill keys truoc khi dung

### 6.2 Dynamic tool list trong system prompt
- system-prompt.ts hien tai hardcode list tools (grep, find, ls, bash, process, browser, cron)
- Nen generate tu actual loaded skills/tools
- Dam bao system prompt va available tools dong bo

---

## Thu tu thuc hien (Timeline)

```
Phase 1 (server.ts monolith)     ████████████████  <- Lam truoc, impact lon nhat
  1.1 Gateway Context            ████
  1.2 Handler Registry           ████████
  1.3 WS Layer                   ████
  1.4 HTTP Routes                ██
  1.5 Logging consolidation      ██

Phase 2 (Agent runtime)          ████████████
  2.1 pi-embedded-runner split   ████
  2.2 pi-embedded-subscribe      ████
  2.3 bash-tools refactor        ██
  2.4 clawdis-tools cleanup      ██

Phase 3 (Telegram)               ████████
  3.1 Remove @ts-nocheck         ████
  3.2 Extract shared code        ██
  3.3 Simplify deliverReplies    ██

Phase 4 (Error handling)         ██████
  4.1-4.4 Error improvements     ██████

Phase 5 (Constants/Config)       ████
Phase 6 (Skills/Prompt)          ████
```

## Nguyen tac khi refactor

1. **Moi phase phai build clean** (`pnpm build` pass) truoc khi chuyen sang phase tiep
2. **Moi phase chay test** (`pnpm test`) - fix broken tests ngay
3. **Ko thay doi behavior** - chi refactor structure, ko them/xoa feature
4. **Commit sau moi sub-phase** (1.1, 1.2, ...) de rollback de
5. **File moi ko qua 300 LOC** - neu qua thi tiep tuc tach
6. **Ko over-engineer** - chi tach khi thuc su can thiet, 3 dong duplicate ok
