// Fails when the published docs are not actually rendered as styled HTML:
// missing pages, raw Markdown leaking into the article, dead internal links,
// or a raw .md URL that no longer serves Markdown. Run after `npm run build`.
import assert from "node:assert/strict";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

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

const listMarkdown = async (dir, prefix = "") => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = `${prefix}${entry.name}`;
    // docs/archive/ holds dated snapshots that are intentionally not rendered.
    if (entry.isDirectory() && entry.name !== "archive")
      files.push(
        ...(await listMarkdown(resolve(dir, entry.name), `${relative}/`)),
      );
    else if (entry.name.endsWith(".md")) files.push(relative);
  }
  return files;
};
const sourceDocs = (await listMarkdown(source)).sort();

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

const checkLinks = async (
  text,
  base,
  label,
  { checkSrc = true, contentBase = null, nestedDir = "" } = {},
) => {
  for (const match of text.matchAll(/(?:href|src)="([^"]+)"/gu)) {
    if (match[0].startsWith("src=") && !checkSrc) continue;
    const href = match[1].split("#")[0];
    if (!href || href.startsWith("/") || /^\w+:/u.test(href)) continue;
    let target = resolve(base, href);
    if (contentBase && !(await exists(target))) {
      const withoutUp = href.replace(/^(?:\.\.\/)+/u, "");
      for (const candidate of [
        resolve(contentBase, withoutUp),
        resolve(contentBase, nestedDir, withoutUp),
      ])
        if (await exists(candidate)) {
          target = candidate;
          break;
        }
    }
    // A .md link is a directory serving an HTML index in the built site.
    if (href.endsWith(".md") && !(await exists(target))) {
      target = resolve(base, href.replace(/\.md$/u, ".html"));
      if (!(await exists(target))) target = resolve(base, href);
    }
    assert.ok(
      (await exists(target)) || (await exists(resolve(target, "index.html"))),
      `${label}: broken ${match[0].split("=")[0]} reference to ${match[1]}`,
    );
  }
};

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
    /<link rel="stylesheet" href="(?:\.\.\/)+docs\.css">/u,
    `${name}: the .md page has a broken stylesheet link`,
  );
  // The .md URL is a directory served by its index.html. Its links are rebased
  // against that directory, so resolve from there; the raw asset paths are
  // intentionally not checked here, only on the canonical .html page.
  await checkLinks(mdHtml, mdUrl, `${name} (.md)`, {
    checkSrc: false,
    // The .md directory variant rebases content links one extra level; only
    // nav links are checked here, against the canonical docs root.
    contentBase: output,
    nestedDir: dirname(name),
  });
  assert.ok(await exists(pagePath), `${name}: the .html page was not built`);
  const html = await readFile(pagePath, "utf8");
  assert.match(
    html,
    /<link rel="stylesheet" href="(?:\.\.\/)*\.\/docs\.css">|<link rel="stylesheet" href="(?:\.\.\/)+docs\.css">/u,
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
      `href="(?:\\./|(?:\\.\\./)+)raw/${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"`,
      "u",
    ),
    `${page}: missing the raw Markdown link`,
  );

  await checkLinks(html, resolve(output, dirname(name)), page, {
    contentBase: output,
    nestedDir: dirname(name),
  });
}

for (const linked of [
  "README.html",
  "CHANGELOG.html",
  "packages/agent/README.html",
  "packages/mcp/README.html",
  "packages/runtime/README.html",
]) {
  const page = resolve(root, "dist-p2p", linked);
  const html = await readFile(page, "utf8");
  const base = resolve(page, "..");
  assert.match(
    html,
    /<link rel="stylesheet" href="[^"]*docs\.css">/u,
    `${linked}: missing the docs stylesheet`,
  );
  await checkLinks(html, base, linked);
}

console.log(
  `Verified ${sourceDocs.length} styled docs pages and their raw Markdown`,
);
