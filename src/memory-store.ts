import Database from "better-sqlite3"
import { randomUUID } from "crypto"

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MemoryEntry {
  id: string
  repo: string
  area: string
  errorSignature: string
  issue: string
  rootCause: string
  fix: string
  tags: string[]
  created: string
}

export interface NewEntry {
  repo: string
  area: string
  errorSignature: string
  issue: string
  rootCause: string
  fix: string
  tags: string[]
}

export interface MemoryStore {
  search(q: { area?: string; text: string; limit?: number }): MemoryEntry[]
  write(e: NewEntry): string
  supersede(id: string, e: NewEntry): string
}

// ─── Row type from DB ─────────────────────────────────────────────────────────

interface MetaRow {
  id: string
  repo: string
  area: string
  error_signature: string
  issue: string
  root_cause: string
  fix: string
  tags: string
  created: string
  superseded_by: string | null
}

// ─── Implementation ───────────────────────────────────────────────────────────

export class SqliteMemoryStore implements MemoryStore {
  private db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma("journal_mode = WAL")
    this.init()
  }

  // Create unified table + FTS5 virtual table with content stored in FTS
  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mem_meta (
        id              TEXT PRIMARY KEY,
        repo            TEXT NOT NULL,
        area            TEXT NOT NULL,
        error_signature TEXT NOT NULL,
        issue           TEXT NOT NULL,
        root_cause      TEXT NOT NULL,
        fix             TEXT NOT NULL,
        tags            TEXT NOT NULL DEFAULT '[]',
        created         TEXT NOT NULL,
        superseded_by   TEXT
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(
        id,
        issue,
        root_cause,
        fix,
        error_signature,
        content=mem_meta,
        content_rowid=rowid
      );

      CREATE TRIGGER IF NOT EXISTS mem_meta_ai AFTER INSERT ON mem_meta BEGIN
        INSERT INTO mem_fts(rowid, id, issue, root_cause, fix, error_signature)
        VALUES (new.rowid, new.id, new.issue, new.root_cause, new.fix, new.error_signature);
      END;

      CREATE TRIGGER IF NOT EXISTS mem_meta_ad AFTER DELETE ON mem_meta BEGIN
        INSERT INTO mem_fts(mem_fts, rowid, id, issue, root_cause, fix, error_signature)
        VALUES ('delete', old.rowid, old.id, old.issue, old.root_cause, old.fix, old.error_signature);
      END;

      CREATE TRIGGER IF NOT EXISTS mem_meta_au AFTER UPDATE ON mem_meta BEGIN
        INSERT INTO mem_fts(mem_fts, rowid, id, issue, root_cause, fix, error_signature)
        VALUES ('delete', old.rowid, old.id, old.issue, old.root_cause, old.fix, old.error_signature);
        INSERT INTO mem_fts(rowid, id, issue, root_cause, fix, error_signature)
        VALUES (new.rowid, new.id, new.issue, new.root_cause, new.fix, new.error_signature);
      END;
    `)
  }

  write(e: NewEntry): string {
    const id = randomUUID()
    const created = new Date().toISOString()

    this.db.prepare(`
      INSERT INTO mem_meta (id, repo, area, error_signature, issue, root_cause, fix, tags, created)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, e.repo, e.area, e.errorSignature, e.issue, e.rootCause, e.fix, JSON.stringify(e.tags), created)

    return id
  }

  supersede(oldId: string, e: NewEntry): string {
    const newId = this.write(e)

    // Mark old entry as superseded — triggers will update FTS index
    this.db.prepare(`UPDATE mem_meta SET superseded_by = ? WHERE id = ?`).run(newId, oldId)

    return newId
  }

  search(q: { area?: string; text: string; limit?: number }): MemoryEntry[] {
    const limit = q.limit ?? 20

    // Wrap phrase in quotes for FTS5 phrase search; escape internal quotes
    const ftsQuery = `"${q.text.replace(/"/g, '""')}"`

    // Query FTS5 joined with meta, excluding superseded entries
    const areaClause = q.area ? `AND m.area = ?` : ""
    const sql = `
      SELECT m.id, m.repo, m.area, m.error_signature,
             m.issue, m.root_cause, m.fix, m.tags, m.created
      FROM mem_fts f
      JOIN mem_meta m ON m.id = f.id
      WHERE mem_fts MATCH ?
        AND m.superseded_by IS NULL
        ${areaClause}
      ORDER BY rank
      LIMIT ?
    `
    const params: unknown[] = q.area ? [ftsQuery, q.area, limit] : [ftsQuery, limit]

    const rows = this.db.prepare(sql).all(...params) as MetaRow[]

    return rows.map((row) => ({
      id: row.id,
      repo: row.repo,
      area: row.area,
      errorSignature: row.error_signature,
      issue: row.issue,
      rootCause: row.root_cause,
      fix: row.fix,
      tags: JSON.parse(row.tags) as string[],
      created: row.created,
    }))
  }
}
