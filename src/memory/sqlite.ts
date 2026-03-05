import Database = require("better-sqlite3");
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

export class MemorySubstrate {
    public db: Database.Database;

    constructor(dbPath: string) {
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        this.db = new Database(dbPath, {
            fileMustExist: false,
        });

        // Use WAL mode for better concurrency
        this.db.pragma("journal_mode = WAL");

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
            now
        );

        return id;
    }

    public recall(query: string, agent_id: string, limit = 5): MemoryEntry[] {
        const stmt = this.db.prepare(`
      SELECT * FROM memories 
      WHERE agent_id = ? AND deleted = 0 AND content LIKE ? 
      ORDER BY accessed_at DESC 
      LIMIT ?
    `);

        const rows = stmt.all(agent_id, `%${query}%`, limit) as MemoryEntry[];

        if (rows.length > 0) {
            const ids = rows.map(r => r.id);
            const updateStmt = this.db.prepare(`
        UPDATE memories 
        SET accessed_at = ?, access_count = access_count + 1 
        WHERE id IN (${ids.map(() => '?').join(',')})
      `);
            updateStmt.run(new Date().toISOString(), ...ids);
        }

        return rows;
    }

    public recent(agent_id: string, limit = 5): MemoryEntry[] {
        const stmt = this.db.prepare(`
      SELECT * FROM memories 
      WHERE agent_id = ? AND deleted = 0
      ORDER BY created_at DESC 
      LIMIT ?
    `);
        return stmt.all(agent_id, limit) as MemoryEntry[];
    }

    public flush() {
        this.db.close();
    }
}

// Singleton instance
let defaultSubstrate: MemorySubstrate | null = null;

export function getMemorySubstrate(workspace: string): MemorySubstrate {
    if (!defaultSubstrate) {
        const dbPath = path.join(workspace, ".clawdis", "memory.sqlite");
        defaultSubstrate = new MemorySubstrate(dbPath);
    }
    return defaultSubstrate;
}
