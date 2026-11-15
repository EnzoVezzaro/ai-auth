#!/usr/bin/env node
import { app, wss } from "../dist/apps/server/src/server.js";

const port = Number(process.env.PORT ?? 3333);
await app.listen({ host: process.env.HOST ?? "127.0.0.1", port });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    for (const socket of wss.clients) socket.close(1001, "server shutdown");
    await app.close();
    process.exit(0);
  });
}
