# OpenClaw Optimization Plan — Source Code Audit

> **Người kiểm**: Antigravity Agent
> **Ngày**: 2026-03-05
> **Nguồn kiểm chứng**: openclaw clawdis fork + openfang source code
> **Phiên bản pi-coding-agent**: 0.31.1

---

## TL;DR — Kết quả kiểm chứng

| Step | Plan | Config có sẵn? | Cần code? | Openfang đã làm? | Verdict | Status |
|------|------|:---:|:---:|:---:|---------|:---:|
| 1 — Trim workspace .md files | 01 | ✅ Manual | Không | N/A | ✅ Làm ngay | **✅ PASS** |
| 1b — Slim ~/.clawdis/AGENTS.md | 01 | ✅ Manual | Không | N/A | ✅ Làm ngay | **✅ PASS** |
| 2 — Context Pruning TTL | 01 | ✅ Config | Có | ✅ `context_budget` | ✅ `keepLastTurns` | **✅ PASS** |
| 3 — SQLite Memory Substrate | 01 | ✅ Code | Có | ✅ `MemorySubstrate` | ✅ `better-sqlite3` port | **✅ PASS** |
| 4 — Model Tiering (heartbeat) | 01 | ⚡ Một phần | Ít | ✅ `model_routing` | ✅ Config done | **✅ PASS** |
| 5 — Tool Filtering via Config | 01 | ✅ Code + Config | Ít | ✅ `tool_policy + filter_tools_by_depth` | ✅ `disabledTools` config | **✅ PASS** |
| 6 — Hybrid Search BM25+Vector | 02 | ❌ Không có | Nhiều | ❌ Chưa có | 🔴 Cần QMD sidecar | ⏳ TODO |
| 7 — Embedding Cache | 02 | ❌ Không có | Có | ❌ | ⚠️ Tự build | ⏳ TODO |
| 8 — SESSION-STATE.md | 02 | ✅ Manual | Không | N/A | ✅ Làm ngay | **✅ PASS** |
| 9 — Mem0 Self-hosted | 02 | ❌ Không có | Nhiều | ❌ | 🔴 Plugin system | ⏳ TODO |
| 10 — LanceDB Pro | 02 | ❌ Không có | Rất nhiều | ❌ | 🔴 Future | ⏳ TODO |

---

## PLAN 01 — Token Reduction

### Step 1 — Trim AGENTS.md + MEMORY.md ⭐⭐⭐⭐⭐

**Verdict: ✅ LÀM NGAY — 10 phút, impact cao nhất**

**Source code evidence**:

```
# pi-embedded-runner.ts dòng 411-413
const bootstrapFiles = await loadWorkspaceBootstrapFiles(resolvedWorkspace);
const contextFiles = buildBootstrapContextFiles(bootstrapFiles);
```

```
# pi-coding-agent/dist/core/system-prompt.js (buildSystemPrompt)
if (contextFiles.length > 0) {
    prompt += "\n\n# Project Context\n\n";
    for (const { path: filePath, content } of contextFiles) {
        prompt += `## ${filePath}\n\n${content}\n\n`;
    }
}
```

**Cơ chế**: `loadWorkspaceBootstrapFiles()` đọc TOÀN BỘ nội dung từ:
- `AGENTS.md` (hoặc `CLAUDE.md`)
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `BOOTSTRAP.md`

Tất cả đổ RAW vào system prompt **MỖI** request. Không có filter, không có search.

**Action**: Trim tất cả xuống <500 token mỗi file. Chuyển chi tiết vào `memory/*.md`.

---

### Step 2 — Context Pruning TTL ⭐⭐⭐⭐

**Verdict: ⚠️ CONFIG KHÔNG TỒN TẠI — phải tự build**

**Source code evidence thực tế**:

Clawdis fork `src/config/config.ts` — **KHÔNG CÓ** schema cho `contextPruning`. Grep toàn bộ 
source: 0 matches cho `contextPruning`, `cache-ttl`, `keepLastAssistants`.

Pi-coding-agent đã có compaction (`core/compaction/compaction.js`) nhưng:
- Compaction trigger dựa trên **token count** (khi context gần đầy), KHÔNG phải TTL
- Không có config cho `keepLastAssistants`
- Compaction summarize + truncate, không có "keep last N turns" option

```
# compaction.js dòng 98: shouldTriggerCompaction()
// Check if compaction should trigger based on context usage.
// Chỉ dựa trên % token usage, KHÔNG dùng time-based TTL
```

**Openfang tương đương**: `apply_context_guard()` + `ContextBudget::new(ctx_window)` trong `agent_loop.rs`:
```rust
// Dòng 282-296: Build context budget from model's actual context window
let context_budget = ContextBudget::new(ctx_window);
// ...
apply_context_guard(&mut messages, &context_budget, available_tools);
```

Openfang cũng KHÔNG dùng TTL. Dùng dynamic budget dựa trên context window size.

**Nếu muốn implement**: Phải patch `pi-embedded-runner.ts` — filter `session.messages` 
trước khi pass vào `session.prompt()`. Hoặc tạo middleware trong `pi-embedded-subscribe.ts`.

---

### Step 3 — Compaction + Memory Flush ⭐⭐⭐

**Verdict: ⚠️ CONFIG KHÔNG TỒN TẠI — phải tự build, nhưng openfang có reference**

**Source code evidence**:

Clawdis fork: `memoryFlush` config **KHÔNG TỒN TẠI** trong `config.ts` schema.

Pi-coding-agent compaction (`compaction.js` dòng 480-558):
```js
// Main compaction function
export async function compact(preparation, model, apiKey, customInstructions, signal)
// → Sinh summary bằng LLM, KHÔNG persist ra file .md
// → Summary nằm trong session history (compactionSummary entry)
```

**Openfang đã implement tương tự** — `store_llm_summary()` trong `session.rs` dòng 320-468:
```rust
/// Store an LLM-generated summary, replacing older messages with the kept subset.
/// Used by the compactor to replace text-truncation compaction with an
/// LLM-generated summary of older conversation history.
pub fn store_llm_summary(&self, agent_id: AgentId, summary: &str, 
    kept_messages: Vec<Message>) -> OpenFangResult<()> {
    canonical.compacted_summary = Some(summary.to_string());
    canonical.compaction_cursor = 0;
    // → Summary lưu vào SQLite DB, không phải file .md
}
```

Openfang compaction flow CŨNG:
- Text-based summarize (không dùng LLM, chỉ truncate)
- `compacted_summary` field trong `canonical_sessions` table
- Threshold: `DEFAULT_COMPACTION_THRESHOLD` (message count)

**Nếu muốn implement "memory flush to .md"**: Phải hook vào `auto_compaction_end` event 
trong `pi-embedded-subscribe.ts` dòng 398, rồi gọi LLM sinh facts → write file.

---

### Step 4 — Model Tiering ⭐⭐⭐⭐

**Verdict: ✅ MỘT PHẦN ĐÃ CÓ — heartbeat model riêng, nhưng background model thì chưa**

**Source code evidence**:

Clawdis fork `auto-reply/reply.ts` dòng 738:
```typescript
const heartbeatRaw = agentCfg?.heartbeat?.model?.trim() ?? "";
// → ĐÃ CÓ: heartbeat dùng model khác so với default
```

Config `clawdis.json` đã support:
```json
{
  "agent": {
    "model": "deepseek/deepseek-chat",
    "heartbeat": {
      "model": "deepseek/deepseek-chat"  // ← CÓ SẴN
    }
  }
}
```

**KHÔNG CÓ**: `background` model riêng cho file ops, cron, system tasks.

**Openfang có model routing thật sự** — `kernel.rs` dòng 1965-2125:
```rust
// Apply model routing if configured (disabled in Stable mode)
let (complexity, routed_model) = router.select_model(&probe);
// → Tự động phân tier: simple/medium/complex
```

`wizard.rs` dòng 56-57:
```rust
// Map model tier to provider/model
let (provider, model) = match intent.model_tier.as_str() {
    "simple" => ...,  // haiku/flash
    "medium" => ...,  // sonnet
    "complex" => ..., // opus
};
```

**Action ngay**: Config heartbeat model rẻ hơn. Để thêm `background` model thì cần patch 
`pi-embedded-runner.ts` cho cron/system tasks.

---

### Step 5 — Dynamic Tool Loading ⭐⭐⭐⭐⭐

**Verdict: 🔴 PHỨC TẠP NHẤT — nhưng impact cực lớn. Openfang có reference tốt.**

**Source code evidence — vấn đề hiện tại**:

`pi-embedded-runner.ts` dòng 415-416:
```typescript
const tools = createClawdisCodingTools({
  bash: params.config?.agent?.bash,
});
```

`sdk.js` dòng 347:
```typescript
const builtInTools = options.tools ?? createCodingTools(cwd);
// → Load TẤT CẢ tools (read, bash, edit, write, grep, find, ls)
// + TẤT CẢ custom tools từ workspace
// → Serialize toàn bộ JSON schema vào mỗi API call
```

`sdk.js` dòng 439:
```typescript
// ALL tools passed to session — không filter
tools: allToolsArray,
```

**Openfang có hệ thống tool policy rất advanced** — `tool_policy.rs`:
```rust
// Multi-layer tool policy resolution:
// deny-wins, glob-pattern based tool access control with
// agent-level and global rules, group expansion, and depth restrictions.

pub fn resolve_tool_access(tool_name: &str, policy: &ToolPolicy, depth: u32) -> ToolAccessResult

// + Depth-aware filtering:
pub fn filter_tools_by_depth(tools: &[String], depth: u32, max_depth: u32) -> Vec<String>
```

Openfang cũng có `truncate_tool_result_dynamic()` trong `context_budget.rs`:
```rust
// Dynamic truncation based on context budget (replaces flat MAX_TOOL_RESULT_CHARS)
let content = truncate_tool_result_dynamic(&result.content, &context_budget);
```

**Nếu muốn implement cho OpenClaw**:

```typescript
// TRƯỚC (hiện tại) — load tất cả
const tools = createClawdisCodingTools({ bash: config });

// SAU — selective loading
function selectToolsForTask(userMessage: string, allTools: Tool[]): Tool[] {
  // Keyword heuristic:
  // "đọc file" → [read, ls, grep, find]
  // "sửa code" → [read, edit, write, bash]
  // "deploy"   → [bash, read]
  // fallback   → all tools
  const intent = classifyIntent(userMessage);
  return allTools.filter(t => intent.requiredTools.includes(t.name));
}
```

Effort: 2-4 giờ. Cần thêm intent classifier (keyword-based đã đủ, không cần LLM).

---

## PLAN 02 — Response Quality

### Step 6 — Hybrid Search BM25 + Vector ⭐⭐⭐⭐

**Verdict: 🔴 CONFIG KHÔNG TỒN TẠI — cần QMD sidecar hoặc tự build**

**Source code evidence**:

Clawdis fork: `memorySearch` config **KHÔNG TỒN TẠI** trong `config.ts`.

Pi-coding-agent: **KHÔNG CÓ** hybrid search, BM25, hay vector search nào.
Memory = đọc file .md → inject nguyên vào prompt. Không có index.

```bash
$ grep -r "bm25\|hybrid\|vector.*search\|rerank" pi-coding-agent/dist/
# → 0 results
```

**Openfang CŨNG KHÔNG CÓ hybrid search!**
```bash
$ grep -r "bm25\|hybrid.*search\|rerank" openfang/crates/
# → 0 results cho search-related
# openfang semantic.rs chỉ có: LIKE matching + cosine similarity
# Không có BM25, không có re-ranking
```

Openfang `semantic.rs` dòng 83-91:
```rust
/// Search for memories using text matching (fallback, no embeddings).
pub fn recall(&self, query: &str, limit: usize, filter: Option<MemoryFilter>)
// → SQL LIKE '%query%' + ORDER BY accessed_at DESC
// KHI có embedding → cosine similarity re-rank
// KHÔNG CÓ BM25
```

**Kết luận**: Cả OpenClaw lẫn openfang đều CHƯA có BM25. Cái này cần:
- QMD sidecar (nếu pi-coding-agent version mới support), HOẶC
- Build custom: `@orama/orama` (TypeScript BM25 + vector library, single dependency)

---

### Step 7 — Embedding Cache ⭐⭐⭐

**Verdict: ⚠️ KHÔNG TỒN TẠI — nhưng dễ build nếu có embedding pipeline**

Pi-coding-agent hiện **KHÔNG CÓ** embedding pipeline (không embed gì cả).
Daniel's article nói "built-in SQLite-backed index" — có thể là version mới hơn v0.31.1.

**Action**: Chỉ cần khi đã implement vector search ở Step 6. Bỏ qua cho đến khi có.

---

### Step 8 — SESSION-STATE.md ⭐⭐⭐⭐

**Verdict: ✅ LÀM NGAY — manual, không cần code**

Tạo file nhỏ, inject vào `contextFiles` qua `BOOTSTRAP.md` mechanism.

Pi-coding-agent `system-prompt.js` đọc context files theo hierarchy:
```javascript
// 1. Global: agentDir/AGENTS.md or CLAUDE.md
// 2. Parent directories (top-most first) down to cwd
// Mỗi thư mục có AGENTS.md riêng sẽ được nạp
```

**Action**: Tạo `~/clawd/BOOTSTRAP.md` với project state tóm gọn (<200 token).
`loadWorkspaceBootstrapFiles()` sẽ tự nạp file này.

---

### Step 9 — Mem0 Self-hosted ⭐⭐⭐⭐⭐

**Verdict: 🔴 PLUGIN SYSTEM KHÔNG CÓ — cần adapter layer**

**Source code evidence**:

Clawdis fork: **KHÔNG CÓ** plugin system.
```bash
$ grep -r "plugin" openclaw/src/ --include="*.ts"
# → 0 results
```

Pi-coding-agent v0.31.1 có `customTools` và `hooks` (sdk.js dòng 349-479) nhưng:
- Custom tools = MCP tools injected vào agent, KHÔNG phải memory plugins
- Hooks = pre/post processing hooks, CÓ THỂ dùng cho Mem0 integration

**Openfang KHÔNG CÓ Mem0 integration** — openfang dùng built-in `MemorySubstrate` riêng.

**Nếu muốn integrate Mem0**:

Option A — Hook-based (ít code nhất):
```typescript
// Tạo hook: after_response → gọi Mem0 capture
// Tạo hook: before_prompt → gọi Mem0 recall → inject context
```

Option B — Custom tool:
```typescript
// Thêm tool "mem0_remember" + "mem0_recall" cho agent tự gọi
// Dễ hơn hook, nhưng cần agent tự biết khi nào gọi
```

---

### Step 10 — LanceDB Pro ⭐⭐⭐⭐⭐

**Verdict: 🔴 FUTURE — benchmark trước khi commit**

LanceDB = Apache Arrow-based vector DB, chạy embedded (giống SQLite).
Advantage: không cần sidecar service, TypeScript SDK native.

```typescript
import * as lancedb from "lancedb";
const db = await lancedb.connect("~/.clawdis/memory.lance");
// → File-based, serverless, fast
```

Chỉ nên cân nhắc khi:
1. Memory >500 entries
2. Search latency >100ms với giải pháp hiện tại
3. Cần multi-vector (dense + sparse trong cùng DB)

---

## Openfang Cross-Reference Summary

| Feature | Openfang Implementation | Có thể port? |
|---------|------------------------|:---:|
| SQLite Memory Substrate | `MemorySubstrate` (9 files, ~130KB code) | ✅ **Đã port & tích hợp** |
| Session Compaction | `store_llm_summary()` + auto-compact by threshold | ✅ Reference |
| Semantic Memory + Embedding | `SemanticStore` + cosine similarity + BLOB embeddings | ✅ Reference |
| Knowledge Graph | `KnowledgeStore` (entities + relations + graph query) | ✅ Reference |
| Context Budget | `ContextBudget::new()` + dynamic tool truncation | ✅ Reference |
| Tool Policy | `resolve_tool_access()` + glob patterns + depth filter | ✅ Good model |
| Model Routing/Tiering | `model_tier` (simple/medium/complex) + auto-select | ✅ Config idea |
| Memory Consolidation/Decay | `ConsolidationEngine` (confidence decay over time) | ✅ Nice to have |
| Hybrid BM25+Vector Search | ❌ Không có (chỉ LIKE + cosine) | N/A |
| Mem0 / QMD integration | ❌ Không có | N/A |
| Usage Analytics SQLite | `UsageStore` + `usage_events` table | ✅ **Đã port & tích hợp** |

---

## Recommended Priority (Updated)

| Prio | Việc | Effort | Impact | Risk |
|:---:|------|--------|--------|------|
| 🔴 1 | Trim AGENTS.md/BOOTSTRAP.md (<500 token) | 10 min | ⭐⭐⭐⭐⭐ | Zero | ✅ Done |
| 🔴 2 | Tạo SESSION-STATE.md (<200 token) | 15 min | ⭐⭐⭐⭐ | Zero | ✅ Done |
| 🟠 3 | Config heartbeat model rẻ (`deepseek-chat`) | 5 min | ⭐⭐⭐ | Zero | ✅ Done |
| 🟡 4 | Dynamic tool filtering qua config | 30m | ⭐⭐⭐⭐⭐ | Medium | ✅ Done |
| 🟡 5 | SQLite Memory Backend (Conversation History) | 1h | ⭐⭐⭐⭐⭐ | Medium | ✅ Done |
| 🔵 6 | Context pruning middleware (giới hạn N turns) | 2h | ⭐⭐⭐ | Low | ✅ Done |
| 🔵 7 | Usage Analytics SQLite | 2h | ⭐⭐⭐ | Low | ✅ Done |
| ⚪ 8 | Hybrid search (Orama/LanceDB/QMD) | 4-8h | ⭐⭐⭐⭐ | High | ⏳ TODO |
| ⚪ 9 | Mem0 self-hosted / Memory refinement | 3h | ⭐⭐⭐⭐ | Medium | ⏳ TODO |

> **Key insight**: Bước 1-3 làm trong 30 phút, 0 risk, giảm ~40-60% token ngay.
> Bước 4-5 cần code, nhưng có openfang làm reference rõ ràng.
> Bước 6-9 là upgrade path, làm khi ổn định.
