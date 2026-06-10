/**
 * Data floor (dev) — Drizzle on bun:sqlite (which IS Cloudflare D1's engine). The table DEFINITIONS live in
 * `schema.ts` (runtime-agnostic, shared with the Worker); here we create the in-memory dev database and apply
 * the same DDL the D1 migration ships. Everything downstream (API, v4 contract, docs, client, UI, cost) is
 * derived from `schema.ts` via the registry in `domain.ts` — Better Auth owns its own users/sessions tables.
 */
import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { SCHEMA_SQL } from "./schema";
import { SEED_SQL } from "./seed";

export const sqlite = new Database(":memory:");
sqlite.run(SCHEMA_SQL);
sqlite.run(SEED_SQL); // the dev DB is in-memory (always empty) → seed the meta store so the local site is alive

export const db: BunSQLiteDatabase = drizzle(sqlite);

// re-export the tables so existing imports (`import { project } from "./db"`) keep working.
export * from "./schema";
