import {
  createScopeAuthorizationProvider,
  PLUGIN_API_VERSION,
} from "../../../packages/runtime/index.js";
import { identityFor } from "../../../packages/p2p/index.js";

function plugin(id, slot, implementation) {
  return {
    id,
    slot,
    apiVersion: PLUGIN_API_VERSION,
    implementation,
    async initialize() {},
  };
}

async function forwardTenant(stub, path, method, data, request) {
  const headers = new Headers({ "content-type": "application/json" });
  if (data.actor) headers.set("x-ai-auth-actor", JSON.stringify(data.actor));
  if (request.headers.get("upgrade") === "websocket") {
    headers.set("upgrade", "websocket");
    const origin = request.headers.get("origin");
    if (origin) headers.set("origin", origin);
    return stub.fetch(
      new Request(`https://workspace.internal${path}`, {
        method: "GET",
        headers,
      }),
    );
  }
  const init = { method, headers };
  if (method !== "GET" && method !== "HEAD") init.body = JSON.stringify(data);
  return stub.fetch(new Request(`https://workspace.internal${path}`, init));
}

export function createWorkerPlugins(env) {
  const tenantStub = (tenantId) =>
    env.WORKSPACES.get(env.WORKSPACES.idFromName(tenantId));
  return [
    plugin("wallet-identity", "identity", { identify: identityFor }),
    plugin(
      "scoped-capabilities",
      "authorization",
      createScopeAuthorizationProvider(),
    ),
    plugin("durable-sqlite", "storage", { getTenant: tenantStub }),
    plugin("workspace-presence", "presence", { getTenant: tenantStub }),
    plugin("durable-websocket", "transport", { forwardTenant }),
    plugin("worker-observability", "observability", {
      record: (event, fields) => console.info(event, fields),
    }),
  ];
}
