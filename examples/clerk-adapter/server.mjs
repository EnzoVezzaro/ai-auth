// Optional, site-owned adapter: maps an AI Auth wallet link to a Clerk account.
// The core wallet does not depend on this file. Plain Node HTTP, no framework.
//
// Routes (all POST, JSON body, JSON envelope { success, data, error }):
//   POST /links        { proof, clerkSession } -> 201 mapping
//   POST /revocations  { event }               -> 200 { linkId, removed }

import { createServer } from "node:http";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_TOKEN_LENGTH = 4096;
const SESSION_VERIFIERS = [
  "verifyClerkSession",
  "verifyLink",
  "verifyLinkRevocation",
];

function envelope(success, data, error) {
  return { success, data, error };
}

function send(res, status, body, { close = false } = {}) {
  const text = JSON.stringify(body);
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  };
  if (close) headers.connection = "close";
  res.writeHead(status, headers);
  res.end(text);
}

function fail(res, status, code, message, options) {
  send(res, status, envelope(false, null, { code, message }), options);
}

function normalizeOrigin(value) {
  if (typeof value !== "string") return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return url.origin === value ? value : null;
}

function isNonEmptyString(value, max = 256) {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function assertConfig(deps) {
  if (!normalizeOrigin(deps.expectedOrigin))
    throw new TypeError("expectedOrigin must be an exact origin");
  if (!isNonEmptyString(deps.expectedResource))
    throw new TypeError("expectedResource is required");
  const caps = deps.expectedCapabilities;
  if (
    !Array.isArray(caps) ||
    caps.length === 0 ||
    !caps.every((c) => isNonEmptyString(c, 64))
  )
    throw new TypeError("expectedCapabilities must be a non-empty string list");
  for (const name of SESSION_VERIFIERS) {
    if (typeof deps[name] !== "function")
      throw new TypeError(`${name} must be a function`);
  }
  if (typeof deps.nonceStore?.consume !== "function")
    throw new TypeError("nonceStore.consume is required");
  const store = deps.mappings;
  if (
    typeof store?.add !== "function" ||
    typeof store?.revoke !== "function" ||
    typeof store?.revokedLinks?.has !== "function"
  )
    throw new TypeError("mappings must be a mapping store");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("too large"), { code: "too_large" }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Returns { ok: true, body } or { ok: false, status, code, message }.
async function parseJsonBody(req) {
  const type = String(req.headers["content-type"] ?? "");
  if (!type.toLowerCase().startsWith("application/json"))
    return {
      ok: false,
      status: 415,
      code: "unsupported_media_type",
      message: "Expected JSON",
    };
  let text;
  try {
    text = await readBody(req);
  } catch (error) {
    if (error.code === "too_large")
      return {
        ok: false,
        status: 413,
        code: "too_large",
        message: "Body too large",
        close: true,
      };
    return {
      ok: false,
      status: 400,
      code: "bad_json",
      message: "Malformed body",
    };
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return {
      ok: false,
      status: 400,
      code: "bad_json",
      message: "Malformed JSON",
    };
  }
  if (!isPlainObject(body))
    return {
      ok: false,
      status: 400,
      code: "invalid_body",
      message: "Body must be an object",
    };
  return { ok: true, body };
}

async function verifySession(deps, token) {
  try {
    const session = await deps.verifyClerkSession(token);
    return isNonEmptyString(session?.userId, 256) ? session.userId : null;
  } catch {
    return null;
  }
}

function linkMapping(clerkUserId, link) {
  const valid =
    isNonEmptyString(link?.walletId, 256) &&
    isNonEmptyString(link?.linkId, 256) &&
    Array.isArray(link?.capabilities) &&
    link.capabilities.every((c) => isNonEmptyString(c, 64));
  if (!valid) return null;
  return {
    clerkUserId,
    walletId: link.walletId,
    scopes: [...link.capabilities],
    linkId: link.linkId,
  };
}

async function handleLinks(deps, req, res) {
  const parsed = await parseJsonBody(req);
  if (!parsed.ok)
    return fail(res, parsed.status, parsed.code, parsed.message, parsed);
  const { proof, clerkSession } = parsed.body;
  if (
    !isPlainObject(proof) ||
    !isNonEmptyString(clerkSession, MAX_TOKEN_LENGTH)
  )
    return fail(
      res,
      400,
      "invalid_body",
      "proof and clerkSession are required",
    );
  if (
    req.headers.origin !== undefined &&
    req.headers.origin !== deps.expectedOrigin
  )
    return fail(res, 403, "origin_mismatch", "Request origin is not allowed");

  const clerkUserId = await verifySession(deps, clerkSession);
  if (!clerkUserId)
    return fail(res, 401, "invalid_session", "Session not valid");

  const result = await deps.verifyLink(proof, {
    expectedOrigin: deps.expectedOrigin,
    expectedResource: deps.expectedResource,
    expectedCapabilities: deps.expectedCapabilities,
    nonceStore: deps.nonceStore,
    revokedLinks: deps.mappings.revokedLinks,
    now: Date.now(),
  });
  if (!result?.valid)
    return fail(res, 422, "invalid_link", "Link proof not valid");

  const mapping = linkMapping(clerkUserId, result.link);
  if (!mapping) return fail(res, 422, "invalid_link", "Link proof not valid");
  if (!deps.mappings.add(mapping))
    return fail(res, 409, "already_linked", "Link already mapped");
  return send(res, 201, envelope(true, mapping, null));
}

async function handleRevocations(deps, req, res) {
  const parsed = await parseJsonBody(req);
  if (!parsed.ok)
    return fail(res, parsed.status, parsed.code, parsed.message, parsed);
  const { event } = parsed.body;
  if (!isPlainObject(event))
    return fail(res, 400, "invalid_body", "event is required");

  const result = await deps.verifyLinkRevocation(event, {
    expectedOrigin: deps.expectedOrigin,
    now: Date.now(),
  });
  const linkId = result?.revocation?.linkId;
  if (!result?.valid || !isNonEmptyString(linkId, 256))
    return fail(res, 422, "invalid_revocation", "Revocation event not valid");

  const removed = deps.mappings.revoke(linkId);
  return send(res, 200, envelope(true, { linkId, removed }, null));
}

const ROUTES = {
  "/links": handleLinks,
  "/revocations": handleRevocations,
};

function route(deps, req, res) {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  const handler = ROUTES[pathname];
  if (!handler) return fail(res, 404, "not_found", "Not found");
  if (req.method !== "POST")
    return fail(res, 405, "method_not_allowed", "Use POST");
  return handler(deps, req, res);
}

// Builds the HTTP server. Verifiers are injected so the site wires in its
// own Clerk check and the real verifyLink / verifyLinkRevocation.
export function createClerkLinkServer(deps = {}) {
  assertConfig(deps);
  const logError = deps.logError ?? ((message) => console.error(message));
  return createServer(async (req, res) => {
    try {
      await route(deps, req, res);
    } catch (error) {
      logError(`clerk-link route failed: ${error?.name ?? "Error"}`);
      if (!res.headersSent) fail(res, 500, "internal_error", "Internal error");
    }
  });
}
