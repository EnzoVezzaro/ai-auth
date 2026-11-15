import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createClerkLinkServer } from "./server.mjs";
import { createMappingStore } from "./mapping-store.mjs";

const ORIGIN = "https://site.example";
const RESOURCE = "site:body4ai";
const GOOD_SESSION = "clerk-session-good";

function linkProof(overrides = {}) {
  return {
    link: {
      linkId: "link_1",
      walletId: "wallet_abc",
      origin: ORIGIN,
      resource: RESOURCE,
      capabilities: ["read"],
      nonce: "nonce-1",
      ...overrides,
    },
  };
}

function revocationEvent(overrides = {}) {
  return {
    revocation: {
      linkId: "link_1",
      walletId: "wallet_abc",
      origin: ORIGIN,
      revokedAt: Date.now(),
      ...overrides,
    },
  };
}

// Mocked Clerk verifier: only the known token is a valid session.
function fakeClerk(impl) {
  return mock.fn(
    impl ??
      (async (token) =>
        token === GOOD_SESSION ? { userId: "user_123" } : null),
  );
}

// Mocked verifyLink: mirrors the checks the adapter relies on.
function fakeVerifyLink() {
  return mock.fn(async (proof, opts) => {
    const link = proof?.link;
    if (!link) return { valid: false, reason: "malformed" };
    if (link.invalid) return { valid: false, reason: "bad-signature" };
    if (link.origin !== opts.expectedOrigin)
      return { valid: false, reason: "origin-mismatch" };
    if (link.resource !== opts.expectedResource)
      return { valid: false, reason: "resource-mismatch" };
    if (opts.revokedLinks?.has(link.linkId))
      return { valid: false, reason: "revoked" };
    if (!(await opts.nonceStore.consume(link.nonce)))
      return { valid: false, reason: "nonce-rejected" };
    return { valid: true, link };
  });
}

// Mocked verifyLinkRevocation: only events not marked invalid pass.
function fakeVerifyRevocation() {
  return mock.fn(async (event, opts) => {
    const rev = event?.revocation;
    if (!rev || rev.invalid) return { valid: false, reason: "bad-signature" };
    if (rev.origin !== opts.expectedOrigin)
      return { valid: false, reason: "origin-mismatch" };
    return { valid: true, revocation: rev };
  });
}

const closers = [];

afterEach(async () => {
  while (closers.length) await closers.pop()();
});

async function start(overrides = {}) {
  const mappings = overrides.mappings ?? createMappingStore();
  const deps = {
    expectedOrigin: ORIGIN,
    expectedResource: RESOURCE,
    expectedCapabilities: ["read", "chat"],
    nonceStore: { consume: async () => true },
    verifyClerkSession: fakeClerk(),
    verifyLink: fakeVerifyLink(),
    verifyLinkRevocation: fakeVerifyRevocation(),
    ...overrides,
    mappings,
  };
  const server = createClerkLinkServer(deps);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  closers.push(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${port}`, mappings, deps };
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function post(base, path, body, headers = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: raw,
  });
  const text = await res.text();
  return { status: res.status, text, json: safeParse(text) };
}

function assertEnvelope(res) {
  assert.ok(res.json, "response must be JSON");
  assert.deepEqual(Object.keys(res.json).sort(), ["data", "error", "success"]);
}

function assertNoStackTrace(res) {
  assert.doesNotMatch(res.text, /\n\s+at /);
  assert.doesNotMatch(res.text, /\.mjs:\d+/);
  assert.doesNotMatch(res.text, /node:internal/);
}

const linkBody = (overrides = {}) => ({
  proof: linkProof(overrides),
  clerkSession: GOOD_SESSION,
});

describe("POST /links: valid input", () => {
  it("creates a mapping for a valid link and valid Clerk session", async () => {
    const { base, mappings } = await start();
    const res = await post(base, "/links", linkBody());
    assert.equal(res.status, 201);
    assertEnvelope(res);
    assert.equal(res.json.success, true);
    assert.equal(res.json.error, null);
    const expected = {
      clerkUserId: "user_123",
      walletId: "wallet_abc",
      scopes: ["read"],
      linkId: "link_1",
    };
    assert.deepEqual(res.json.data, expected);
    assert.deepEqual(mappings.get("link_1"), expected);
  });

  it("passes site origin, resource, capabilities and revocations to verifyLink", async () => {
    const { base, deps } = await start();
    await post(base, "/links", linkBody());
    const opts = deps.verifyLink.mock.calls[0].arguments[1];
    assert.equal(opts.expectedOrigin, ORIGIN);
    assert.equal(opts.expectedResource, RESOURCE);
    assert.deepEqual(opts.expectedCapabilities, ["read", "chat"]);
    assert.equal(typeof opts.revokedLinks.has, "function");
  });
});

describe("POST /links: rejections create no mapping", () => {
  it("rejects an invalid Clerk session with 401 and skips link verification", async () => {
    const { base, mappings, deps } = await start();
    const res = await post(base, "/links", {
      proof: linkProof(),
      clerkSession: "forged",
    });
    assert.equal(res.status, 401);
    assertEnvelope(res);
    assert.equal(res.json.success, false);
    assert.equal(res.json.data, null);
    assert.equal(mappings.get("link_1"), undefined);
    assert.equal(deps.verifyLink.mock.callCount(), 0);
  });

  it("rejects a throwing Clerk verifier with 401 and no stack trace", async () => {
    const { base, mappings } = await start({
      verifyClerkSession: fakeClerk(async () => {
        throw new Error("jwks fetch failed at /srv/secret.mjs:12");
      }),
    });
    const res = await post(base, "/links", linkBody());
    assert.equal(res.status, 401);
    assertNoStackTrace(res);
    assert.doesNotMatch(res.text, /jwks|secret/);
    assert.equal(mappings.get("link_1"), undefined);
  });

  it("rejects an invalid link proof with 422", async () => {
    const { base, mappings } = await start();
    const res = await post(base, "/links", linkBody({ invalid: true }));
    assert.equal(res.status, 422);
    assertEnvelope(res);
    assert.equal(res.json.success, false);
    assert.equal(res.json.error.code, "invalid_link");
    assert.equal(mappings.get("link_1"), undefined);
  });

  it("rejects a link whose origin does not match the site with 422", async () => {
    const { base, mappings } = await start();
    const res = await post(
      base,
      "/links",
      linkBody({ origin: "https://evil.example" }),
    );
    assert.equal(res.status, 422);
    assert.equal(mappings.get("link_1"), undefined);
  });

  it("rejects a request whose Origin header does not match the site with 403", async () => {
    const { base, mappings, deps } = await start();
    const res = await post(base, "/links", linkBody(), {
      origin: "https://evil.example",
    });
    assert.equal(res.status, 403);
    assertEnvelope(res);
    assert.equal(mappings.get("link_1"), undefined);
    assert.equal(deps.verifyLink.mock.callCount(), 0);
  });

  it("rejects a replayed nonce with 422 and keeps the first mapping", async () => {
    const seen = new Set();
    const { base, mappings } = await start({
      nonceStore: {
        async consume(nonce) {
          if (seen.has(nonce)) return false;
          seen.add(nonce);
          return true;
        },
      },
    });
    const first = await post(base, "/links", linkBody());
    assert.equal(first.status, 201);
    const replay = await post(base, "/links", linkBody());
    assert.equal(replay.status, 422);
    assert.equal(replay.json.error.code, "invalid_link");
    assert.equal(mappings.get("link_1").walletId, "wallet_abc");
  });

  it("does not let a duplicate linkId overwrite an existing mapping", async () => {
    const { base, mappings } = await start();
    await post(base, "/links", linkBody());
    const again = await post(
      base,
      "/links",
      linkBody({ walletId: "wallet_other" }),
    );
    assert.equal(again.status, 409);
    assert.equal(mappings.get("link_1").walletId, "wallet_abc");
  });
});

describe("POST /links: input validation", () => {
  it("returns 400 with an envelope for bad JSON, without a stack trace", async () => {
    const { base } = await start();
    const res = await post(base, "/links", "{not json");
    assert.equal(res.status, 400);
    assertEnvelope(res);
    assert.equal(res.json.success, false);
    assert.equal(res.json.error.code, "bad_json");
    assertNoStackTrace(res);
  });

  it("returns 400 when the body is not a JSON object", async () => {
    const { base } = await start();
    const res = await post(base, "/links", "[1,2,3]");
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, "invalid_body");
  });

  it("returns 400 when proof or clerkSession is missing or malformed", async () => {
    const { base, deps } = await start();
    const bodies = [
      { clerkSession: GOOD_SESSION },
      { proof: linkProof(), clerkSession: 42 },
      { proof: linkProof(), clerkSession: "" },
      { proof: linkProof(), clerkSession: "x".repeat(10_000) },
    ];
    for (const body of bodies) {
      const res = await post(base, "/links", body);
      assert.equal(res.status, 400);
      assertEnvelope(res);
    }
    assert.equal(deps.verifyClerkSession.mock.callCount(), 0);
  });

  it("returns 413 for an oversized body", async () => {
    const { base } = await start();
    const res = await post(base, "/links", {
      ...linkBody(),
      padding: "x".repeat(70_000),
    });
    assert.equal(res.status, 413);
    assertEnvelope(res);
  });

  it("returns 404 for unknown routes and 405 for the wrong method", async () => {
    const { base } = await start();
    const unknown = await post(base, "/nope", {});
    assert.equal(unknown.status, 404);
    assertEnvelope(unknown);
    const wrongMethod = await fetch(`${base}/links`);
    assert.equal(wrongMethod.status, 405);
    assert.equal(safeParse(await wrongMethod.text()).success, false);
  });
});

describe("POST /revocations: unlink", () => {
  it("removes the mapping when a valid revocation event arrives", async () => {
    const { base, mappings } = await start();
    await post(base, "/links", linkBody());
    assert.ok(mappings.get("link_1"));
    const res = await post(base, "/revocations", { event: revocationEvent() });
    assert.equal(res.status, 200);
    assertEnvelope(res);
    assert.equal(res.json.success, true);
    assert.deepEqual(res.json.data, { linkId: "link_1", removed: true });
    assert.equal(mappings.get("link_1"), undefined);
  });

  it("keeps the mapping when the revocation event is invalid", async () => {
    const { base, mappings } = await start();
    await post(base, "/links", linkBody());
    const res = await post(base, "/revocations", {
      event: revocationEvent({ invalid: true }),
    });
    assert.equal(res.status, 422);
    assert.equal(res.json.success, false);
    assert.ok(mappings.get("link_1"));
  });

  it("rejects a revocation for a different origin", async () => {
    const { base, mappings } = await start();
    await post(base, "/links", linkBody());
    const res = await post(base, "/revocations", {
      event: revocationEvent({ origin: "https://evil.example" }),
    });
    assert.equal(res.status, 422);
    assert.ok(mappings.get("link_1"));
  });

  it("blocks a later link proof for a revoked linkId", async () => {
    const { base, mappings } = await start();
    await post(base, "/links", linkBody());
    await post(base, "/revocations", { event: revocationEvent() });
    const relink = await post(base, "/links", linkBody());
    assert.equal(relink.status, 422);
    assert.equal(mappings.get("link_1"), undefined);
  });

  it("returns 400 for bad JSON on the revocation route", async () => {
    const { base } = await start();
    const res = await post(base, "/revocations", "{");
    assert.equal(res.status, 400);
    assertNoStackTrace(res);
  });
});

describe("configuration and internal errors", () => {
  it("refuses to start without required verifiers, and with a bad origin", () => {
    assert.throws(() => createClerkLinkServer({}), TypeError);
    assert.throws(
      () =>
        createClerkLinkServer({
          expectedOrigin: "not a url",
          expectedResource: RESOURCE,
          expectedCapabilities: ["read"],
          nonceStore: { consume: async () => true },
          verifyClerkSession: fakeClerk(),
          verifyLink: fakeVerifyLink(),
          verifyLinkRevocation: fakeVerifyRevocation(),
          mappings: createMappingStore(),
        }),
      TypeError,
    );
  });

  it("returns a generic 500 envelope when an internal dependency throws", async () => {
    const { base } = await start({
      verifyLink: mock.fn(async () => {
        throw new Error("db password=hunter2 at /srv/x.mjs:9");
      }),
    });
    const res = await post(base, "/links", linkBody());
    assert.equal(res.status, 500);
    assertEnvelope(res);
    assert.equal(res.json.error.message, "Internal error");
    assertNoStackTrace(res);
    assert.doesNotMatch(res.text, /hunter2/);
  });
});
