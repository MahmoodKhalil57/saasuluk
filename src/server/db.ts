/**
 * Data floor — Drizzle on bun:sqlite (which IS Cloudflare D1). The domain table `project` is the SaaS
 * resource; Better Auth manages its own users/sessions tables in the same database. Everything downstream
 * (API, v4 contract, docs, client, UI, cost) is derived from these definitions.
 */
import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const sqlite = new Database(":memory:");

export const project = sqliteTable("project", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  ownerId: text("owner_id"),
  status: text("status", { enum: ["active", "archived"] }).notNull().default("active"),
});

sqlite.run(`CREATE TABLE IF NOT EXISTS project (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  owner_id TEXT,
  status TEXT NOT NULL DEFAULT 'active'
)`);

export const db: BunSQLiteDatabase = drizzle(sqlite);
