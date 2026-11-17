import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const SITE = "https://enzovezzaro.github.io/ai-auth/";
const html = await readFile(resolve(root, "index.html"), "utf8");

const meta = (attr, name) => {
  const pattern = new RegExp(
    `<meta\\s+(?:[^>]*\\s)?${attr}="${name}"\\s+content="([^"]*)"`,
    "u",
  );
  const multiline = new RegExp(
    `<meta\\s[^>]*${attr}="${name}"[^>]*content="([^"]*)"`,
    "su",
  );
  return (html.match(pattern) ?? html.match(multiline))?.[1];
};

test("the landing page declares its canonical URL", () => {
  assert.match(html, new RegExp(`<link rel="canonical" href="${SITE}"`, "u"));
});

test("the meta description is a useful length", () => {
  const description = meta("name", "description");
  assert.ok(description, "meta description is present");
  assert.ok(description.length >= 120, `too short: ${description.length}`);
  assert.ok(description.length <= 160, `too long: ${description.length}`);
});

test("the page has exactly one h1 and it names the product", () => {
  const h1s = html.match(/<h1[\s>]/gu) ?? [];
  assert.equal(h1s.length, 1);
  assert.match(html, /<h1[^>]*>[\s\S]*Your agents\.[\s\S]*<\/h1>/u);
});

test("social preview image is absolute, sized, and exists in the repo", async () => {
  const image = `${SITE}docs/assets/social-card.jpg`;
  assert.equal(meta("property", "og:image"), image);
  assert.equal(meta("name", "twitter:image"), image);
  assert.equal(meta("property", "og:image:width"), "1200");
  assert.equal(meta("property", "og:image:height"), "630");
  const info = await stat(resolve(root, "docs/assets/social-card.jpg"));
  assert.ok(info.size > 0);
});

test("open graph and twitter cards name the site and repeat title and description", () => {
  assert.equal(meta("property", "og:site_name"), "AI Auth");
  assert.equal(meta("property", "og:url"), SITE);
  assert.ok(meta("property", "og:title"));
  assert.ok(meta("property", "og:description"));
  assert.ok(meta("name", "twitter:title"));
  assert.ok(meta("name", "twitter:description"));
  assert.equal(meta("name", "twitter:card"), "summary_large_image");
});

test("structured data describes the software and parses as JSON-LD", () => {
  const block = html.match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/u,
  );
  assert.ok(block, "a JSON-LD block is present");
  const data = JSON.parse(block[1]);
  assert.equal(data["@context"], "https://schema.org");
  assert.equal(data["@type"], "SoftwareApplication");
  assert.equal(data.name, "AI Auth");
  assert.equal(data.url, SITE);
  assert.equal(data.license, "https://opensource.org/licenses/MIT");
  assert.equal(data.offers?.price, "0");
  assert.match(data.codeRepository, /github\.com\/EnzoVezzaro\/ai-auth/u);
});

test("robots.txt allows crawling and points to the sitemap; the wallet and demo stay crawlable so their noindex tags can be read", async () => {
  const robots = await readFile(resolve(root, "robots.txt"), "utf8");
  assert.match(robots, /^User-agent: \*$/mu);
  assert.match(robots, /^Allow: \/$/mu);
  assert.doesNotMatch(robots, /^Disallow: \/wallet/mu);
  assert.doesNotMatch(robots, /^Disallow: \/body4ai/mu);
  assert.match(robots, new RegExp(`^Sitemap: ${SITE}sitemap\\.xml$`, "mu"));
});

test("sitemap.xml lists the landing page at its canonical URL", async () => {
  const sitemap = await readFile(resolve(root, "sitemap.xml"), "utf8");
  assert.match(
    sitemap,
    /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/u,
  );
  assert.match(sitemap, new RegExp(`<loc>${SITE}</loc>`, "u"));
  assert.doesNotMatch(sitemap, /wallet|body4ai/u);
});

test("the static build ships robots.txt and sitemap.xml and keeps the wallet and demo out of search", async () => {
  const build = await readFile(
    resolve(root, "scripts/build-p2p-static.mjs"),
    "utf8",
  );
  assert.match(build, /robots\.txt/u);
  assert.match(build, /sitemap\.xml/u);
  assert.match(build, /noindex/u);
});
