import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_DISCOVERY_BYTES,
  fetchDiscovery,
  normalizeOrigin,
  validateDiscovery,
} from "../packages/p2p/discovery.js";

const ORIGIN = "https://site.example";
const doc = (extra = {}) => ({
  type: "ai-auth-discovery",
  v: 1,
  origin: ORIGIN,
  name: "Site",
  capabilities: ["presence.read", "tools.invoke"],
  rooms: [{ name: "research", mode: "restricted" }],
  walletUrl: "https://wallet.example/",
  webmcp: true,
  ...extra,
});
const reply =
  (body, { status = 200, type = "application/json" } = {}) =>
  async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": type },
    });

test("origins must be exact: https, or http only for localhost", () => {
  assert.equal(normalizeOrigin("https://site.example"), ORIGIN);
  assert.equal(normalizeOrigin("https://site.example/"), ORIGIN);
  assert.equal(
    normalizeOrigin("http://localhost:8080"),
    "http://localhost:8080",
  );
  assert.equal(
    normalizeOrigin("http://127.0.0.1:3000"),
    "http://127.0.0.1:3000",
  );
  for (const bad of [
    "http://site.example",
    "https://site.example/path",
    "https://user:pw@site.example",
    "https://site.example?x=1",
    "ftp://site.example",
    "site.example",
    "",
    null,
  ])
    assert.equal(normalizeOrigin(bad), "", String(bad));
});

test("a valid document passes and is returned frozen and cloned", () => {
  const input = doc();
  const result = validateDiscovery(input, { origin: ORIGIN });
  assert.equal(result.ok, true);
  assert.equal(Object.isFrozen(result.discovery), true);
  assert.notEqual(result.discovery, input);
});

test("documents are rejected for wrong origin, version, unknown fields and bad values", () => {
  const reasons = (d, origin = ORIGIN) =>
    validateDiscovery(d, { origin }).reason;
  assert.equal(
    reasons(doc({ origin: "https://evil.example" })),
    "origin-mismatch",
  );
  assert.equal(reasons(doc(), "https://other.example"), "origin-mismatch");
  assert.equal(reasons(doc(), "http://site.example"), "bad-origin");
  assert.equal(reasons(doc({ v: 2 })), "not-a-v1-document");
  assert.equal(reasons(doc({ extra: 1 })), "unknown-field");
  assert.equal(
    reasons(doc({ capabilities: ["root.access"] })),
    "bad-capabilities",
  );
  assert.equal(
    reasons(doc({ capabilities: ["tools.invoke", "tools.invoke"] })),
    "bad-capabilities",
  );
  assert.equal(
    reasons(doc({ rooms: [{ name: "a b", mode: "open" }] })),
    "bad-rooms",
  );
  assert.equal(
    reasons(doc({ rooms: [{ name: "ok", mode: "secret-mode" }] })),
    "bad-rooms",
  );
  assert.equal(
    reasons(doc({ walletUrl: "http://wallet.example/" })),
    "bad-walletUrl",
  );
  assert.equal(
    reasons(doc({ walletUrl: "https://wallet.example/?t=1" })),
    "bad-walletUrl",
  );
  assert.equal(reasons(doc({ issuers: ["bob"] })), "bad-issuers");
  assert.equal(reasons(doc({ name: "" })), "bad-name");
  assert.equal(reasons([]), "not-an-object");
});

test("documents that contain secrets are rejected", () => {
  const reasons = (d) => validateDiscovery(d, { origin: ORIGIN }).reason;
  assert.equal(
    reasons(doc({ name: "Bearer abcdef0123456789abcdef" })),
    "contains-secret",
  );
  assert.equal(
    reasons(doc({ name: "key sk-abcdef0123456789abcd" })),
    "contains-secret",
  );
  assert.equal(
    reasons(doc({ rooms: [{ name: "r", mode: "open", apiKey: "x" }] })),
    "contains-secret",
  );
  // Secret-looking keys never reach the allow-list check silently.
  assert.equal(reasons({ ...doc(), privateKey: "x" }), "contains-secret");
});

test("fetchDiscovery requests the well-known path without credentials or redirects", async () => {
  let seen;
  const result = await fetchDiscovery(ORIGIN, {
    fetch: async (url, init) => {
      seen = { url, init };
      return reply(doc())();
    },
  });
  assert.equal(result.ok, true);
  assert.equal(seen.url, "https://site.example/.well-known/ai-auth.json");
  assert.equal(seen.init.redirect, "error");
  assert.equal(seen.init.credentials, "omit");
});

test("fetchDiscovery fails closed on bad status, type, size, json and transport errors", async () => {
  const reason = async (fetchImpl, options = {}) =>
    (await fetchDiscovery(ORIGIN, { fetch: fetchImpl, ...options })).reason;
  assert.equal(await reason(reply({}, { status: 404 })), "http-error");
  assert.equal(
    await reason(reply(doc(), { type: "text/html" })),
    "bad-content-type",
  );
  assert.equal(await reason(reply("{not json")), "bad-json");
  assert.equal(
    await reason(
      reply(JSON.stringify(doc({ name: "x".repeat(MAX_DISCOVERY_BYTES) }))),
    ),
    "too-large",
  );
  assert.equal(await reason(reply(doc()), { maxBytes: 20 }), "too-large");
  assert.equal(
    await reason(async () => {
      throw new Error("offline");
    }),
    "fetch-failed",
  );
  assert.equal(
    await reason(reply(doc({ origin: "https://evil.example" }))),
    "origin-mismatch",
  );
  assert.equal(
    (await fetchDiscovery("http://site.example")).reason,
    "bad-origin",
  );
});

test("a hung server times out instead of hanging", async () => {
  const hang = (_url, { signal }) =>
    new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(new Error("aborted"))),
    );
  assert.equal(
    (await fetchDiscovery(ORIGIN, { fetch: hang, timeoutMs: 20 })).reason,
    "fetch-failed",
  );
});
