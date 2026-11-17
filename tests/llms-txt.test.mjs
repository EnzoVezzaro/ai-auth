import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const SITE = "https://enzovezzaro.github.io/ai-auth/";
const REPO = "https://github.com/EnzoVezzaro/ai-auth";
const text = await readFile(resolve(root, "llms.txt"), "utf8");

// Docs the static build copies into dist-p2p/docs. Other docs are linked to GitHub.
const PUBLISHED_DOCS = [
  "ARCHITECTURE.md",
  "SECURITY.md",
  "protocol.md",
  "RECOVERY.md",
];

const links = () =>
  [...text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/gu)].map((m) => m[1]);

test("llms.txt starts with the product name as an H1 and a one-line summary blockquote", () => {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  assert.equal(lines[0], "# AI Auth");
  assert.match(lines[1], /^> \S/u);
});

test("llms.txt describes what the product does in plain language", () => {
  assert.match(text, /wallet/iu);
  assert.match(text, /agents?/iu);
  assert.match(text, /capabilit/iu);
  assert.match(text, /MIT/u);
});

const NPM = "https://www.npmjs.com/package/@enzovezzaro/";

test("every link is https and points at the live site, the repository, or an npm package of ours", () => {
  const found = links();
  assert.ok(found.length >= 6, `expected several links, found ${found.length}`);
  for (const url of found)
    assert.ok(
      url.startsWith(SITE) || url.startsWith(REPO) || url.startsWith(NPM),
      `unexpected link host: ${url}`,
    );
});

test("site links to raw published docs match files the build copies", async () => {
  const siteDocs = links()
    .filter((url) => url.startsWith(`${SITE}docs/raw/`))
    .map((url) => url.slice(`${SITE}docs/raw/`.length));
  assert.ok(siteDocs.length > 0, "at least one published doc is linked");
  for (const name of siteDocs)
    assert.ok(
      PUBLISHED_DOCS.includes(name),
      `${name} is not copied by the build`,
    );
});

test("repository links resolve to files in this repository", async () => {
  const repoPaths = links()
    .filter((url) => url.startsWith(`${REPO}/blob/main/`))
    .map((url) => url.slice(`${REPO}/blob/main/`.length));
  assert.ok(repoPaths.length > 0, "at least one repository file is linked");
  for (const path of repoPaths) {
    const info = await stat(resolve(root, path));
    assert.ok(info.isFile(), `${path} is not a file in the repository`);
  }
});

test("the static build ships llms.txt at the site root", async () => {
  const build = await readFile(
    resolve(root, "scripts/build-p2p-static.mjs"),
    "utf8",
  );
  assert.match(build, /llms\.txt/u);
});
