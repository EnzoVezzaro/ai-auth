import test from "node:test";
import assert from "node:assert/strict";
import { createAIAuthConnectInstruction } from "@enzovezzaro/ai-auth-wallet";
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
  assert.equal(result.discoveryOnly, true);
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
