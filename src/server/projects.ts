/** Drizzle-backed CRUD handlers for the `project` domain table, bound to the contract-generated routes. */
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { db, project } from "./db";

const id = (c: Context) => Number(c.req.param("id"));
export const projectHandlers = {
  list: (c: Context) => c.json(db.select().from(project).all()),
  get: (c: Context) => { const r = db.select().from(project).where(eq(project.id, id(c))).get(); return r ? c.json(r) : c.json({ error: "not found" }, 404); },
  create: async (c: Context) => { const body = (await c.req.json()) as Record<string, unknown>; const r = db.insert(project).values({ ...body, ownerId: c.req.header("x-user") ?? null } as typeof project.$inferInsert).returning().get(); return c.json(r, 201); },
  update: async (c: Context) => { const body = (await c.req.json()) as Record<string, unknown>; db.update(project).set(body).where(eq(project.id, id(c))).run(); return c.json(db.select().from(project).where(eq(project.id, id(c))).get()); },
  delete: (c: Context) => { db.delete(project).where(eq(project.id, id(c))).run(); return c.body(null, 204); },
};
