import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createAIAuthConnectInstruction } from "@enzovezzaro/ai-auth-wallet";
import { validateDiscovery } from "../../p2p/discovery.js";
import { parseConnectInput, fetchSiteManifest } from "../connect-input.js";

const made = createAIAuthConnectInstruction({
  siteOrigin: "https://site.example",
  walletUrl: "https://wallet.example/wallet/",
  capabilities: ["tools.invoke", "presence.read"],
  room: "lobby",
  siteName: "Site",
});

test("parses a copied connect instruction (text) and its JSON descriptor", () => {
  for (const text of [made.instruction, made.json]) {
    const parsed = parseConnectInput(text);
    assert.equal(parsed.origin, "https://site.example");
    assert.equal(parsed.room, "lobby");
    assert.deepEqual(parsed.capabilities, ["presence.read", "tools.invoke"]);
    assert.equal(parsed.source, "instruction");
    assert.equal(parsed.discoveryOnly, false);
  }
});

test("a bare URL is discovery only: origin, no capabilities, never consent", () => {
  const parsed = parseConnectInput("https://site.example/some/page?x=1");
  assert.deepEqual(
    {
      origin: parsed.origin,
      caps: parsed.capabilities,
      only: parsed.discoveryOnly,
      source: parsed.source,
    },
    { origin: "https://site.example", caps: [], only: true, source: "url" },
  );
});

test("B11: a copied custom-room instruction keeps its room; a URL query is only a location hint, never a grant", async () => {
  // The connect page publishes ?room=custom-room in its public setup link. The
  // copied command must carry that room explicitly (--room): parsing the bare
  // URL alone is discovery-only and would otherwise resolve to rooms[0].
  const custom = createAIAuthConnectInstruction({
    siteOrigin: "https://site.example",
    walletUrl: "https://wallet.example/wallet/",
    capabilities: ["presence.read"],
    room: "custom-room",
    siteName: "Site",
  });
  for (const clipboard of [custom.instruction, custom.json]) {
    const parsed = parseConnectInput(clipboard);
    assert.equal(parsed.origin, "https://site.example");
    assert.equal(parsed.room, "custom-room");
    assert.equal(parsed.discoveryOnly, false);
  }

  const hint = parseConnectInput(
    "https://site.example/connect-agent/?room=custom-room",
  );
  assert.equal(hint.origin, "https://site.example");
  assert.equal(hint.room, null, "the query is not parsed as an authorization");
  assert.equal(hint.discoveryOnly, true);
  assert.deepEqual(hint.capabilities, []);

  // Discovery alone picks the manifest's first room. That is exactly why the
  // copied command must pass --room when the link selected another room.
  const discovered = await fetchSiteManifest("https://site.example", {
    fetch: okFetch({
      ...strictManifest,
      rooms: [{ name: "default", mode: "open" }],
    }),
  });
  assert.equal(discovered.room, "default");
  assert.equal(discovered.discoveryOnly, true);
});

test("rejects unsafe or malformed input", () => {
  for (const bad of [
    "",
    "   ",
    "javascript:alert(1)",
    "http://evil.example",
    "ftp://x.example",
    "not a url",
    "{}",
    "x".repeat(20_000),
  ])
    assert.throws(
      () => parseConnectInput(bad),
      /connect|origin|input|url/i,
      bad.slice(0, 30),
    );
  assert.throws(
    () =>
      parseConnectInput(
        JSON.stringify({ ...JSON.parse(made.json), capabilities: ["*"] }),
      ),
    /capabilit/i,
  );
  assert.throws(
    () =>
      parseConnectInput(
        JSON.stringify({
          ...JSON.parse(made.json),
          origin: "https://site.example/x",
        }),
      ),
    /origin/i,
  );
});

const manifest = {
  origin: "https://site.example",
  room: "lobby",
  capabilities: ["presence.read"],
};
const okFetch =
  (body, init = {}) =>
  async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
      ...init,
    });

test("manifest fetch returns requested capabilities for the exact origin", async () => {
  let seen;
  const result = await fetchSiteManifest("https://site.example", {
    fetch: async (url, init) => (
      (seen = { url: String(url), init }),
      okFetch(manifest)()
    ),
  });
  assert.equal(seen.url, "https://site.example/.well-known/ai-auth.json");
  assert.equal(seen.init.redirect, "error");
  assert.deepEqual(result.capabilities, ["presence.read"]);
  assert.equal(result.room, "lobby");
  assert.equal(result.discoveryOnly, true);
  assert.equal(result.source, "manifest-provisional");
  assert.equal(result.provisional, true);
});

test("manifest for a different origin, bad JSON, wildcard caps, oversize or 404 is rejected", async () => {
  const cases = [
    okFetch({ ...manifest, origin: "https://other.example" }),
    okFetch("{nope"),
    okFetch({ ...manifest, capabilities: ["*"] }),
    okFetch("x".repeat(40_000)),
    async () => new Response("", { status: 404 }),
  ];
  for (const fetch of cases)
    await assert.rejects(fetchSiteManifest("https://site.example", { fetch }));
});

const strictManifest = {
  type: "ai-auth-discovery",
  v: 1,
  origin: "https://site.example",
  name: "Site",
  walletUrl: "https://wallet.example/",
  docsUrl: "https://site.example/docs/agents",
  capabilities: ["presence.read", "tools.invoke"],
  rooms: [{ name: "research", mode: "restricted" }],
  webmcp: true,
};

test("a strict v1 discovery document yields a real room and capabilities", async () => {
  let seen;
  const result = await fetchSiteManifest("https://site.example", {
    fetch: async (url, init) => (
      (seen = { url: String(url), init }),
      okFetch(strictManifest)()
    ),
  });
  assert.equal(seen.url, "https://site.example/.well-known/ai-auth.json");
  assert.equal(seen.init.redirect, "error");
  assert.deepEqual(result.capabilities, ["presence.read", "tools.invoke"]);
  assert.equal(result.room, "research");
  assert.equal(result.walletUrl, "https://wallet.example/");
  assert.equal(result.source, "manifest");
  assert.equal(result.provisional, false);
  assert.equal(result.discoveryOnly, true);
});

test("discovery falls back to a site path prefix on static hosts", async () => {
  const seen = [];
  const result = await fetchSiteManifest(
    "https://site.example/ai-auth/wallet/",
    {
      fetch: async (url) => {
        seen.push(String(url));
        if (String(url) === "https://site.example/.well-known/ai-auth.json")
          return { ok: false, status: 404, headers: new Headers() };
        return okFetch(strictManifest)();
      },
    },
  );
  assert.deepEqual(seen.slice(0, 2), [
    "https://site.example/.well-known/ai-auth.json",
    "https://site.example/ai-auth/.well-known/ai-auth.json",
  ]);
  assert.equal(result.room, "research");
  assert.equal(result.provisional, false);
});

test("strict discovery without rooms or capabilities still resolves safely", async () => {
  const result = await fetchSiteManifest("https://site.example", {
    fetch: okFetch({
      ...strictManifest,
      rooms: undefined,
      capabilities: undefined,
    }),
  });
  assert.equal(result.room, "default");
  assert.deepEqual(result.capabilities, []);
  assert.equal(result.provisional, false);
});

test("a strict document with a secret or unknown field is not relabelled provisional", async () => {
  for (const bad of [
    { ...strictManifest, apiKey: "sk-abcdef0123456789abcdef" },
    { ...strictManifest, name: "sk-abcdef0123456789abcdef" },
    { ...strictManifest, type: "ai-auth-dictionary" },
  ])
    await assert.rejects(
      fetchSiteManifest("https://site.example", { fetch: okFetch(bad) }),
      /discovery document|invalid|rejected/i,
    );
});

test("the built static site publishes a valid strict discovery hint", async (t) => {
  const url = new URL(
    "../../../dist-p2p/.well-known/ai-auth.json",
    import.meta.url,
  );
  let text;
  try {
    text = await readFile(url, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return t.skip("run npm run build first");
    throw error;
  }
  const doc = JSON.parse(text);
  const result = validateDiscovery(doc, { origin: doc.origin });
  assert.equal(result.ok, true, result.reason);
  assert.equal(doc.type, "ai-auth-discovery");
  assert.equal(doc.v, 1);
  assert.equal(doc.origin, "https://enzovezzaro.github.io");
  assert.ok(doc.capabilities.length > 0 && doc.capabilities.length <= 5);
  assert.ok(doc.rooms.length > 0 && doc.rooms.length <= 8);
  assert.equal(doc.webmcp, true);
  assert.ok(Buffer.byteLength(text) <= 16 * 1024);
});
