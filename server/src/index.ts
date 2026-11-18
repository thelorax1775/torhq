import { loadEnv } from "./config/env.js";
import { initDb } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import { makeContext } from "./lib/context.js";
import { buildApp } from "./app.js";
import { Worker } from "./queue/queue.js";
import { purgeExpiredSessions } from "./auth/session.js";
import { getAdapter } from "./adapters/registry.js";
import type { QbittorrentAdapter } from "./adapters/qbittorrent.js";
import { reconcileWanted } from "./lib/wanted.js";

async function main(): Promise<void> {
  const env = loadEnv();
  initDb(env.TORHQ_DATA_DIR);
  runMigrations();

  const ctx = makeContext(env);
  const app = await buildApp(ctx);

  // Background intake worker.
  const worker = new Worker(env.approvedRoots, ctx.masterKey);
  worker.start();

  // Periodic session cleanup.
  const cleanup = setInterval(() => purgeExpiredSessions(), 60 * 60 * 1000);
  cleanup.unref?.();

  // Books: turn finished `torhq-books` downloads into intake previews. Read-only
  // until an admin approves; see lib/wanted.ts.
  let reconciling = false;
  const books = setInterval(() => {
    if (reconciling) return;
    reconciling = true;
    void reconcileWanted({
      qb: () => getAdapter("qbittorrent", ctx.masterKey) as QbittorrentAdapter | null,
      approvedRoots: env.approvedRoots,
    }).catch((e) => app.log.warn({ err: e }, "books reconcile failed")).finally(() => { reconciling = false; });
  }, 30_000);
  books.unref?.();

  await app.listen({ host: env.TORHQ_HOST, port: env.TORHQ_PORT });

  const shutdown = async (sig: string) => {
    app.log.info({ sig }, "shutting down");
    worker.stop();
    clearInterval(cleanup);
    clearInterval(books);
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal:", err);
  process.exit(1);
});
