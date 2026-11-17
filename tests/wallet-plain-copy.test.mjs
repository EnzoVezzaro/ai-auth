import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Visible wallet copy must not use internal names. Developer-only identifiers
// in <code> elements and code comments are exempt.
const BANNED = [
  /Nostr/u,
  /WebRTC/u,
  /IndexedDB/u,
  /Delegat/u,
  /\bPeers?\b/u,
  /[Cc]ryptographic identity/u,
  /[Cc]onsent proof/u,
  /[Ss]coped (?:request|consent|delegation)/u,
  /[Bb]lockchain/u,
  /\bchain\b/u,
  /Sign selected capabilities/u,
  /Approve selected/u,
];

function visibleText(source) {
  return source
    .replaceAll(/<code>[\s\S]*?<\/code>/gu, "")
    .replaceAll("NostrWebRTC", "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

for (const file of ["apps/p2p/index.html", "apps/p2p/app.js"]) {
  test(`${file} shows no internal names in visible copy`, async () => {
    const source = visibleText(
      await readFile(new URL(`../${file}`, import.meta.url), "utf8"),
    );
    const found = BANNED.filter((term) => term.test(source)).map(String);
    assert.deepEqual(found, []);
  });
}

test("the wallet page links its copy module and its approval buttons use plain verbs", async () => {
  const source = await readFile(
    new URL("../apps/p2p/app.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /Allow selected permissions/u);
  assert.match(source, /Don't allow/u);
  assert.match(source, /extendLabel/u);
});
