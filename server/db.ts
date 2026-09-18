import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Drizzle schema is the source of truth for typed application records. The
// compact bootstrap DDL below deliberately creates a fresh schema; legacy Go
// databases are not migrated by design.
export const assets = sqliteTable('assets', { id: text('id').primaryKey(), kind: text('kind').notNull(), storageKey: text('storage_key').notNull(), mimeType: text('mime_type').notNull(), byteSize: integer('byte_size').notNull(), sha256: text('sha256').notNull(), status: text('status').notNull(), createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull() });
export const characters = sqliteTable('characters', { id: text('id').primaryKey(), name: text('name').notNull(), defaultCardId: text('default_card_id'), status: text('status').notNull(), createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull() });
export const sessions = sqliteTable('sessions', { id: text('id').primaryKey(), title: text('title').notNull(), characterId: text('character_id'), activeCardId: text('active_card_id'), status: text('status').notNull(), lastMessageAt: integer('last_message_at').notNull(), lastMessagePreview: text('last_message_preview'), createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull() });
export const schema = { assets, characters, sessions };

export function openDatabase(filename: string) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const client = new Database(filename);
  const db = drizzle(client, { schema });
  client.pragma('journal_mode = WAL');
  client.pragma('foreign_keys = ON');
  client.exec(`
    CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, kind TEXT, storage_key TEXT, mime_type TEXT, byte_size INTEGER, sha256 TEXT, status TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS characters (id TEXT PRIMARY KEY, name TEXT NOT NULL, default_card_id TEXT, status TEXT DEFAULT 'active', created_at INTEGER, updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS character_cards (id TEXT PRIMARY KEY, character_id TEXT, name TEXT, source_asset_ids TEXT, output_asset_id TEXT, prompt_version TEXT, model_name TEXT, status TEXT, is_default INTEGER DEFAULT 0, metadata_status TEXT DEFAULT 'pending', metadata TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT, character_id TEXT, active_card_id TEXT, status TEXT DEFAULT 'active', last_message_at INTEGER, last_message_preview TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, kind TEXT, content TEXT, asset_id TEXT, generation_id TEXT, client_request_id TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS generations (id TEXT PRIMARY KEY, session_id TEXT, parent_generation_id TEXT, prompt TEXT, model_name TEXT, quality_preset TEXT, aspect_ratio TEXT, status TEXT, output_asset_id TEXT, error_code TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS session_references (id TEXT PRIMARY KEY, session_id TEXT, asset_id TEXT, purpose TEXT, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS gallery_items (id TEXT PRIMARY KEY, generation_id TEXT UNIQUE, asset_id TEXT, title TEXT, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS gallery_exclusions (generation_id TEXT PRIMARY KEY, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS character_memories (id TEXT PRIMARY KEY, character_id TEXT, category TEXT, constraint_text TEXT, normalized_key TEXT, priority TEXT, status TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS memory_candidates (id TEXT PRIMARY KEY, character_id TEXT, category TEXT, constraint_text TEXT, priority TEXT, status TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, kind TEXT, resource_id TEXT, status TEXT, attempts INTEGER, max_attempts INTEGER, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS error_logs (id TEXT PRIMARY KEY, kind TEXT, resource_id TEXT, code TEXT, message TEXT, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS model_calls (id TEXT PRIMARY KEY, kind TEXT, resource_id TEXT, model_name TEXT, cost REAL DEFAULT 0, prompt_tokens INTEGER DEFAULT 0, completion_tokens INTEGER DEFAULT 0, total_tokens INTEGER DEFAULT 0, created_at INTEGER);
  `);
  // Existing installations predate card names. Keep the bootstrap schema
  // additive so those databases gain the field without a manual migration.
  const cardColumns = client.prepare('PRAGMA table_info(character_cards)').all() as Array<{ name: string }>;
  if (!cardColumns.some(column => column.name === 'name')) client.exec('ALTER TABLE character_cards ADD COLUMN name TEXT');
  client.exec("UPDATE sessions SET title=COALESCE((SELECT name FROM characters WHERE characters.id=sessions.character_id), '创作') || ' · ' || strftime('%m/%d %H:%M', created_at / 1000, 'unixepoch', 'localtime') WHERE title='新对话'");
  return db;
}
export const now = () => Date.now();
