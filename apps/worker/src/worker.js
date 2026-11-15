import { createPluginHost } from "../../../packages/runtime/index.js";
import { AuthDirectory } from "./auth-directory.js";
import { createWorkerPlugins } from "./providers.js";
import { Workspace } from "./workspace.js";

const MAX_REQUEST_BYTES = 64 * 1024;
const ALLOWED_CAPABILITIES = new Set([
  "auth.session",
  "tenant.create",
  "tenant.delete",
  "tenant.join",
  "tenant.invite",
  "tenant.member.revoke",
  "messages.read",
  "messages.write",
  "presence.read",
  "presence.publish",
]);
const pluginHosts = new WeakMap();

function getPluginHost(env) {
  let host = pluginHosts.get(env);
  if (!host) {
    host = createPluginHost(createWorkerPlugins(env));
    pluginHosts.set(env, host);
  }
  return host;
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function originAllowed(request, env) {
  const origin = request.headers.get("origin");
  const allowed = new Set(
    String(env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  return origin && allowed.has(origin) ? origin : null;
}

function configuredOrigin(value, env) {
  return (
    typeof value === "string" &&
    String(env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((item) => item.trim())
      .includes(value)
  );
}

function cors(response, origin) {
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  headers.set("access-control-allow-headers", "authorization, content-type");
  headers.set("access-control-max-age", "600");
  headers.append("vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function readJson(request) {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_REQUEST_BYTES) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function tokenFrom(request) {
  const value = request.headers.get("authorization") ?? "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

async function authenticated(request, env, host) {
  const token = tokenFrom(request);
  if (!token) return null;
  const directory = env.AUTH_DIRECTORY.get(
    env.AUTH_DIRECTORY.idFromName("global"),
  );
  const session = await directory.verifySessionToken(token);
  if (!session) return null;
  return { ...session, token };
}

function requireScope(session, scope, host) {
  return (
    Boolean(session) &&
    host.get("authorization").implementation.allows(session, scope) === true
  );
}

function tenantStub(tenantId, host, slot = "storage") {
  return host.get(slot).implementation.getTenant(tenantId);
}

export { AuthDirectory, Workspace };

export default {
  async fetch(request, env) {
    const origin = originAllowed(request, env);
    if (request.headers.has("origin") && !origin)
      return json({ error: "Origin is not allowed" }, 403);
    if (request.method === "OPTIONS") {
      if (!origin) return json({ error: "Origin is not allowed" }, 403);
      return cors(new Response(null, { status: 204 }), origin);
    }

    try {
      const host = await getPluginHost(env);
      const url = new URL(request.url);
      const path = url.pathname.split("/").filter(Boolean);
      host.get("observability").implementation.record("http.request.started", {
        method: request.method,
        routeGroup: path[1] ?? "root",
      });
      if (path[0] !== "v1")
        return cors(json({ error: "Not found" }, 404), origin);

      const directory = env.AUTH_DIRECTORY.get(
        env.AUTH_DIRECTORY.idFromName("global"),
      );
      if (path[1] === "health" && request.method === "GET") {
        try {
          await directory.health();
          return cors(
            json({ ok: true, ready: true, version: "0.1.0" }),
            origin,
          );
        } catch {
          return cors(json({ ok: false, ready: false }, 503), origin);
        }
      }
      if (
        path[1] === "auth" &&
        path[2] === "challenge" &&
        path.length === 3 &&
        request.method === "POST"
      ) {
        const body = await readJson(request);
        const audience = origin ?? body?.audience;
        if (
          !configuredOrigin(audience, env) ||
          (origin && body?.audience && body.audience !== origin)
        )
          return cors(
            json({ error: "A configured exact origin is required" }, 400),
            origin,
          );
        if (
          !Array.isArray(body?.capabilities) ||
          body.capabilities.length === 0 ||
          body.capabilities.some(
            (capability) => !ALLOWED_CAPABILITIES.has(capability),
          )
        )
          return cors(
            json({ error: "Requested capabilities are invalid" }, 400),
            origin,
          );
        const challenge = await directory.createChallenge({
          audience,
          capabilities: body.capabilities,
          clientKey: request.headers.get("cf-connecting-ip") ?? "unknown",
        });
        if (!challenge)
          return cors(json({ error: "Challenge limit reached" }, 429), origin);
        return cors(json({ request: challenge }, 201), origin);
      }
      if (
        path[1] === "auth" &&
        path[2] === "session" &&
        path.length === 4 &&
        path[3] === "revoke" &&
        request.method === "POST"
      ) {
        const revoked = await directory.revokeSession(tokenFrom(request));
        return cors(json({ revoked }, revoked ? 200 : 401), origin);
      }
      if (
        path[1] === "auth" &&
        path[2] === "session" &&
        path.length === 3 &&
        request.method === "POST"
      ) {
        const body = await readJson(request);
        if (!body?.consent)
          return cors(
            json({ error: "Signed consent is required" }, 400),
            origin,
          );
        let agentId;
        try {
          agentId = await host
            .get("identity")
            .implementation.identify(body.consent?.proof?.publicKey);
        } catch {
          return cors(
            json(
              { error: "Signed consent is invalid, expired, or already used" },
              401,
            ),
            origin,
          );
        }
        const created = await directory.createSession({
          consent: body.consent,
          agentId,
        });
        if (!created)
          return cors(
            json(
              { error: "Signed consent is invalid, expired, or already used" },
              401,
            ),
            origin,
          );
        return cors(json(created, 201), origin);
      }
      if (
        path[1] === "tenants" &&
        path[2] &&
        path[3] === "rooms" &&
        path[4] &&
        path[5] === "events" &&
        path.length === 6 &&
        request.method === "GET" &&
        request.headers.get("upgrade") === "websocket"
      ) {
        if (!origin)
          return json({ error: "WebSocket origin is not allowed" }, 403);
        if (
          !(await directory.allowWebSocketHandshake(
            request.headers.get("cf-connecting-ip"),
          ))
        )
          return cors(
            json({ error: "WebSocket rate limit exceeded" }, 429),
            origin,
          );
        if (!(await directory.tenantExists(path[2])))
          return cors(json({ error: "Tenant not found" }, 404), origin);
        const stub = tenantStub(path[2], host, "presence");
        const internalPath = `/internal/events/${encodeURIComponent(path[4])}`;
        const response = await host
          .get("transport")
          .implementation.forwardTenant(stub, internalPath, "GET", {}, request);
        if (response.status === 101) return response;
        return cors(response, origin);
      }
      const session = await authenticated(request, env, host);
      if (!session)
        return cors(json({ error: "Authentication required" }, 401), origin);

      if (
        path[1] === "tenants" &&
        path.length === 2 &&
        request.method === "POST"
      ) {
        if (!requireScope(session, "tenant.create", host))
          return cors(
            json({ error: "tenant.create permission required" }, 403),
            origin,
          );
        const body = await readJson(request);
        const name =
          typeof body?.name === "string" ? body.name.trim().slice(0, 80) : "";
        if (!name)
          return cors(json({ error: "Tenant name is required" }, 400), origin);
        const tenantId = crypto.randomUUID();
        const registered = await directory.registerTenant({
          tenantId,
          ownerAgentId: session.agentId,
        });
        if (!registered)
          return cors(json({ error: "Tenant capacity reached" }, 429), origin);
        const stub = tenantStub(tenantId, host);
        try {
          const tenant = await stub.initializeTenant({
            tenantId,
            name,
            ownerAgentId: session.agentId,
          });
          return cors(json({ tenant }, 201), origin);
        } catch {
          await directory.removeTenant({
            tenantId,
            ownerAgentId: session.agentId,
          });
          return cors(
            json({ error: "Tenant could not be created" }, 409),
            origin,
          );
        }
      }

      if (
        path[1] === "tenants" &&
        path[2] &&
        path.length === 3 &&
        request.method === "DELETE"
      ) {
        if (!requireScope(session, "tenant.delete", host))
          return cors(
            json({ error: "tenant.delete permission required" }, 403),
            origin,
          );
        const tenantId = path[2];
        if (
          !(await directory.tenantOwnedBy({
            tenantId,
            ownerAgentId: session.agentId,
          }))
        )
          return cors(json({ error: "Tenant not found" }, 404), origin);
        const stub = tenantStub(tenantId, host);
        const actor = {
          agentId: session.agentId,
          capabilities: session.capabilities,
        };
        const response = await host
          .get("transport")
          .implementation.forwardTenant(
            stub,
            "/internal/tenant",
            "DELETE",
            { actor },
            request,
          );
        if (!response.ok) return cors(response, origin);
        await directory.removeTenant({
          tenantId,
          ownerAgentId: session.agentId,
        });
        return cors(response, origin);
      }

      if (path[1] === "tenants" && path[2]) {
        const tenantId = path[2];
        if (!(await directory.tenantExists(tenantId)))
          return cors(json({ error: "Tenant not found" }, 404), origin);
        const subpath = path.slice(3);
        const actor = {
          agentId: session.agentId,
          capabilities: session.capabilities,
        };
        let internalPath = "";
        let data = { actor };
        let method = request.method;
        if (subpath[0] === "invitations" && request.method === "POST") {
          internalPath = "/internal/invitations";
          data.grant = (await readJson(request))?.grant;
        } else if (
          subpath[0] === "invitations" &&
          subpath[1] &&
          request.method === "DELETE"
        ) {
          internalPath = `/internal/invitations/${encodeURIComponent(subpath[1])}`;
        } else if (
          subpath[0] === "members" &&
          subpath[1] &&
          request.method === "DELETE"
        ) {
          internalPath = `/internal/members/${encodeURIComponent(decodeURIComponent(subpath[1]))}`;
        } else if (subpath[0] === "join" && request.method === "POST") {
          internalPath = "/internal/join";
          data.grant = (await readJson(request))?.grant;
        } else if (
          subpath[0] === "rooms" &&
          subpath[1] &&
          subpath[2] === "messages" &&
          ["GET", "POST"].includes(method)
        ) {
          const room = encodeURIComponent(subpath[1]);
          internalPath = `/internal/messages/${room}`;
          if (method === "POST") data.body = (await readJson(request))?.body;
        } else {
          return cors(json({ error: "Not found" }, 404), origin);
        }
        const stub = tenantStub(tenantId, host);
        const response = await host
          .get("transport")
          .implementation.forwardTenant(
            stub,
            internalPath,
            method,
            data,
            request,
          );
        if (response.status === 101) return response;
        return cors(response, origin);
      }
      return cors(json({ error: "Not found" }, 404), origin);
    } catch {
      return cors(json({ error: "Internal service error" }, 500), origin);
    }
  },
};
