import Database from "better-sqlite3";
import * as path from "node:path";
import * as fs from "node:fs";
import * as crypto from "node:crypto";

export interface MemoryEntry {
  id: string;
  agent_id: string;
  content: string;
  source: string;
  scope: string;
  confidence: number;
  metadata: string;
  created_at: string;
  accessed_at: string;
  access_count: number;
  deleted: number;
  embedding?: Buffer | null;
}

export interface HybridSearchResult extends MemoryEntry {
  score: number;
  bm25Score: number;
  vectorScore: number;
}

// --- Embedding helpers ---

function bufferToFloats(buf: Buffer): Float32Array {
  const arr = new Float32Array(buf.byteLength / 4);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = buf.readFloatLE(i * 4);
  }
  return arr;
}

function floatsToBuffer(arr: number[]): Buffer {
  const buf = Buffer.allocUnsafe(arr.length * 4);
  for (let i = 0; i < arr.length; i++) {
    buf.writeFloatLE(arr[i], i * 4);
  }
  return buf;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

async function fetchGeminiEmbedding(
  text: string,
  apiKey: string,
): Promise<number[] | null> {
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "models/text-embedding-004",
          content: { parts: [{ text }] },
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      embedding?: { values?: number[] };
    };
    return data?.embedding?.values ?? null;
  } catch {
    return null;
  }
}

// --- MemorySubstrate ---

export class MemorySubstrate {
  public db: Database.Database;
  private geminiApiKey: string | null = null;

  constructor(dbPath: string, geminiApiKey?: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath, { fileMustExist: false });
    this.db.pragma("journal_mode = WAL");
    this.geminiApiKey = geminiApiKey?.trim() || null;
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          content TEXT NOT NULL,
          source TEXT NOT NULL,
          scope TEXT NOT NULL DEFAULT 'episodic',
          confidence REAL NOT NULL DEFAULT 1.0,
          metadata TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          accessed_at TEXT NOT NULL,
          access_count INTEGER NOT NULL DEFAULT 0,
          deleted INTEGER NOT NULL DEFAULT 0,
          embedding BLOB
      );
      CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id, deleted, accessed_at);
      CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, deleted);

      -- FTS5 virtual table for BM25 full-text search
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
          id UNINDEXED,
          agent_id UNINDEXED,
          content,
          tokenize = 'unicode61'
      );

      CREATE TABLE IF NOT EXISTS usage_events (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          cache_write_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          duration_ms INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_usage_events_agent ON usage_events(agent_id);
    `);
  }

  public store(params: {
    agent_id: string;
    content: string;
    source: string;
    scope?: string;
    metadata?: Record<string, unknown>;
  }): string {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO memories (id, agent_id, content, source, scope, metadata, created_at, accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      params.agent_id,
      params.content,
      params.source,
      params.scope || "episodic",
      JSON.stringify(params.metadata || {}),
      now,
      now,
    );

    // Index into FTS5
    this.db
      .prepare("INSERT INTO memories_fts(id, agent_id, content) VALUES (?, ?, ?)")
      .run(id, params.agent_id, params.content);

    // Fire-and-forget embedding (does not block store())
    if (this.geminiApiKey) {
      this.embedAsync(id, params.content);
    }

    return id;
  }

  private embedAsync(id: string, content: string): void {
    const key = this.geminiApiKey;
    if (!key) return;
    fetchGeminiEmbedding(content, key)
      .then((vec) => {
        if (!vec) return;
        const buf = floatsToBuffer(vec);
        this.db
          .prepare("UPDATE memories SET embedding = ? WHERE id = ?")
          .run(buf, id);
      })
      .catch(() => {
        // Non-fatal
      });
  }

  /**
   * Hybrid BM25 + vector search.
   * Falls back to BM25-only when no embeddings are available.
   */
  public async recallHybrid(
    query: string,
    agent_id: string,
    limit = 5,
    weights = { bm25: 0.4, vector: 0.6 },
  ): Promise<HybridSearchResult[]> {
    const candidateLimit = limit * 4;

    // --- BM25 via FTS5 ---
    const ftsRows = this.db
      .prepare(
        `SELECT m.*, fts.rank as bm25_rank
         FROM memories_fts fts
         JOIN memories m ON m.id = fts.id
         WHERE fts.agent_id = ? AND memories_fts MATCH ?
           AND m.deleted = 0
         ORDER BY fts.rank
         LIMIT ?`,
      )
      .all(agent_id, this.ftsQuery(query), candidateLimit) as (MemoryEntry & {
      bm25_rank: number;
    })[];

    // bm25_rank from FTS5 is negative (lower = better), convert to 0..1
    const bm25Map = new Map<string, number>();
    for (const row of ftsRows) {
      // rank is negative; normalize to positive score
      const score = 1 / (1 + Math.max(0, -row.bm25_rank));
      bm25Map.set(row.id, score);
    }

    // --- Vector search (cosine similarity) ---
    const vectorMap = new Map<string, number>();
    if (this.geminiApiKey) {
      const queryVec = await fetchGeminiEmbedding(query, this.geminiApiKey);
      if (queryVec) {
        const queryArr = new Float32Array(queryVec);
        // Load all non-null embeddings for this agent
        const rows = this.db
          .prepare(
            `SELECT id, embedding FROM memories
             WHERE agent_id = ? AND deleted = 0 AND embedding IS NOT NULL`,
          )
          .all(agent_id) as { id: string; embedding: Buffer }[];

        for (const row of rows) {
          const memVec = bufferToFloats(row.embedding);
          const sim = cosineSimilarity(queryArr, memVec);
          if (sim > 0.1) vectorMap.set(row.id, sim);
        }
      }
    }

    // --- Merge candidates ---
    const allIds = new Set([...bm25Map.keys(), ...vectorMap.keys()]);
    if (allIds.size === 0) {
      // Fallback: recency
      return this.recentAsHybrid(agent_id, limit);
    }

    // Normalize weights
    const hasVector = vectorMap.size > 0;
    const w = hasVector
      ? weights
      : { bm25: 1.0, vector: 0.0 };

    const scored: HybridSearchResult[] = [];
    for (const id of allIds) {
      const bm25Score = bm25Map.get(id) ?? 0;
      const vectorScore = vectorMap.get(id) ?? 0;
      const score = w.bm25 * bm25Score + w.vector * vectorScore;

      // Fetch full row (may already be in ftsRows)
      let entry = ftsRows.find((r) => r.id === id);
      if (!entry) {
        entry = this.db
          .prepare("SELECT * FROM memories WHERE id = ?")
          .get(id) as MemoryEntry & { bm25_rank: number };
      }
      if (!entry) continue;

      scored.push({
        ...(entry as MemoryEntry),
        score,
        bm25Score,
        vectorScore,
      });
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);

    // Update access timestamps
    if (top.length > 0) {
      const ids = top.map((r) => r.id);
      this.db
        .prepare(
          `UPDATE memories SET accessed_at = ?, access_count = access_count + 1
           WHERE id IN (${ids.map(() => "?").join(",")})`,
        )
        .run(new Date().toISOString(), ...ids);
    }

    return top;
  }

  /** Synchronous LIKE-based recall (kept for backward compat, now delegates to BM25). */
  public recall(query: string, agent_id: string, limit = 5): MemoryEntry[] {
    // BM25 sync path
    try {
      const rows = this.db
        .prepare(
          `SELECT m.*
           FROM memories_fts fts
           JOIN memories m ON m.id = fts.id
           WHERE fts.agent_id = ? AND memories_fts MATCH ?
             AND m.deleted = 0
           ORDER BY fts.rank
           LIMIT ?`,
        )
        .all(agent_id, this.ftsQuery(query), limit) as MemoryEntry[];

      if (rows.length > 0) {
        const ids = rows.map((r) => r.id);
        this.db
          .prepare(
            `UPDATE memories SET accessed_at = ?, access_count = access_count + 1
             WHERE id IN (${ids.map(() => "?").join(",")})`,
          )
          .run(new Date().toISOString(), ...ids);
        return rows;
      }
    } catch {
      // FTS5 not available, fall back to LIKE
    }

    // LIKE fallback
    const stmt = this.db.prepare(`
      SELECT * FROM memories
      WHERE agent_id = ? AND deleted = 0 AND content LIKE ?
      ORDER BY accessed_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(agent_id, `%${query}%`, limit) as MemoryEntry[];
    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      this.db
        .prepare(
          `UPDATE memories SET accessed_at = ?, access_count = access_count + 1
           WHERE id IN (${ids.map(() => "?").join(",")})`,
        )
        .run(new Date().toISOString(), ...ids);
    }
    return rows;
  }

  public recent(agent_id: string, limit = 5): MemoryEntry[] {
    return this.db
      .prepare(
        `SELECT * FROM memories
         WHERE agent_id = ? AND deleted = 0
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(agent_id, limit) as MemoryEntry[];
  }

  private recentAsHybrid(
    agent_id: string,
    limit: number,
  ): HybridSearchResult[] {
    return this.recent(agent_id, limit).map((e) => ({
      ...e,
      score: 0,
      bm25Score: 0,
      vectorScore: 0,
    }));
  }

  /** Escape query for FTS5 — wrap in quotes to handle special chars. */
  private ftsQuery(raw: string): string {
    // Strip FTS5 special characters, then quote
    const cleaned = raw.replace(/['"*^]/g, " ").trim();
    return `"${cleaned}"`;
  }

  public logUsage(params: {
    agent_id: string;
    provider: string;
    model: string;
    usage: {
      input: number;
      output: number;
      cacheRead?: number;
      cacheWrite?: number;
      total: number;
    };
    durationMs: number;
  }) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO usage_events (
            id, agent_id, provider, model,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
            duration_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.agent_id,
        params.provider,
        params.model,
        params.usage.input,
        params.usage.output,
        params.usage.cacheRead || 0,
        params.usage.cacheWrite || 0,
        params.usage.total,
        params.durationMs,
        now,
      );
  }

  public flush() {
    this.db.close();
  }
}

// Singleton instance
let defaultSubstrate: MemorySubstrate | null = null;

export function getMemorySubstrate(
  workspace: string,
  geminiApiKey?: string,
): MemorySubstrate {
  if (!defaultSubstrate) {
    const dbPath = path.join(workspace, ".clawdis", "memory.sqlite");
    defaultSubstrate = new MemorySubstrate(dbPath, geminiApiKey);
  }
  return defaultSubstrate;
}
