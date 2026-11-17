// Fails when the published docs are not actually rendered as styled HTML:
// missing pages, raw Markdown leaking into the article, dead internal links,
// or a raw .md URL that no longer serves Markdown. Run after `npm run build`.
import assert from "node:assert/strict";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "docs");
const output = resolve(root, "dist-p2p", "docs");

const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const sourceDocs = (await readdir(source))
  .filter((name) => name.endsWith(".md"))
  .sort();

assert.ok(sourceDocs.length > 0, "no source docs were found");
assert.ok(await exists(output), "run npm run build before verifying docs");
assert.ok(
  await exists(resolve(output, "docs.css")),
  "the docs stylesheet was not published",
);
assert.ok(
  await exists(resolve(output, "index.html")),
  "the docs index was not published",
);
for (const linked of [
  "README.html",
  "CHANGELOG.html",
  "packages/agent/README.html",
  "packages/mcp/README.html",
  "packages/runtime/README.html",
])
  assert.ok(
    await exists(resolve(root, "dist-p2p", linked)),
    `a docs page links to ${linked} but it was not published`,
  );

for (const name of sourceDocs) {
  const page = name.replace(/\.md$/u, ".html");
  const rawPath = resolve(output, "raw", name);
  const pagePath = resolve(output, page);
  const mdUrl = resolve(output, name);

  assert.ok(await exists(rawPath), `${name}: raw Markdown was not published`);
  const raw = await readFile(rawPath, "utf8");
  assert.match(raw, /^#\s+\S/u, `${name}: the raw copy must stay Markdown`);

  // /docs/<name>.md must serve styled HTML, not text/markdown plain text.
  const mdStat = await stat(mdUrl).catch(() => null);
  assert.ok(
    mdStat?.isDirectory(),
    `${name}: the .md URL must be a directory that serves an HTML index`,
  );
  const mdIndex = resolve(mdUrl, "index.html");
  assert.ok(await exists(mdIndex), `${name}: the .md URL has no styled index`);
  const mdHtml = await readFile(mdIndex, "utf8");
  assert.match(
    mdHtml,
    /<link rel="stylesheet" href="\.\.\/docs\.css">/u,
    `${name}: the .md page has a broken stylesheet link`,
  );
  for (const match of mdHtml.matchAll(/href="([^"]+)"/gu)) {
    const href = match[1].split("#")[0];
    if (!href || href.startsWith("/") || /^\w+:/u.test(href)) continue;
    const target = resolve(mdUrl, href);
    assert.ok(
      (await exists(target)) || (await exists(resolve(target, "index.html"))),
      `${name}: the .md page has a broken link to ${match[1]}`,
    );
  }
  assert.ok(await exists(pagePath), `${name}: the .html page was not built`);
  const html = await readFile(pagePath, "utf8");
  assert.match(
    html,
    /<link rel="stylesheet" href="\.\/docs\.css">/u,
    `${page}: missing the docs stylesheet`,
  );
  assert.equal(
    (html.match(/<h1\b/gu) ?? []).length,
    1,
    `${page}: expected exactly one title`,
  );
  assert.doesNotMatch(
    html,
    /<p>\s*\|/u,
    `${page}: an unrendered table row leaked into the article`,
  );
  assert.doesNotMatch(
    html,
    /<p>[^<]*```/u,
    `${page}: an unrendered code fence leaked into the article`,
  );
  assert.match(
    html,
    new RegExp(
      `href="\\./raw/${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"`,
      "u",
    ),
    `${page}: missing the raw Markdown link`,
  );

  for (const match of html.matchAll(/href="([^"]+)"/gu)) {
    const href = match[1].split("#")[0];
    if (!href || href.startsWith("/") || /^\w+:/u.test(href)) continue;
    const targetPath = resolve(output, href);
    assert.ok(
      (await exists(targetPath)) ||
        (await exists(resolve(targetPath, "index.html"))),
      `${page}: dead internal link to ${match[1]}`,
    );
  }
}

console.log(
  `Verified ${sourceDocs.length} styled docs pages and their raw Markdown`,
);
