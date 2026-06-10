/** Runnable API entry — `bun run dev:api`. The same `app` deploys to a Cloudflare Worker unchanged. */
import { createApp } from "./api";
const { app } = await createApp();
const port = Number(process.env.PORT ?? 3000);
Bun.serve({ port, fetch: app.fetch });
console.log(`saasuluk API on http://localhost:${port} — /scalar · /openapi.json · /superadmin · /cost · /api/auth/* · /api/health`);
