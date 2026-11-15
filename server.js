import Fastify from "fastify";
import { app } from "./dist/apps/server/src/server.js";

void Fastify;
await app.ready();
export default app.server;
