import assert from "node:assert/strict";
import test from "node:test";
import { renderDocPage, renderMarkdown } from "../scripts/render-docs.mjs";

test("headings get stable ids and a self link", () => {
  const { html, headings } = renderMarkdown(
    "## Transport and reachability\n\nText.\n",
  );
  assert.match(html, /<h2 id="transport-and-reachability">/u);
  assert.match(html, /href="#transport-and-reachability"/u);
  assert.deepEqual(headings, [
    {
      level: 2,
      title: "Transport and reachability",
      id: "transport-and-reachability",
    },
  ]);
});

test("pipe tables render with a header and aligned cells", () => {
  const md = [
    "| Name | Runs where |",
    "| ---- | ---------- |",
    "| Wallet | Browser |",
    "| Agent | Local process |",
  ].join("\n");
  const { html } = renderMarkdown(md);
  assert.match(html, /<div class="table-scroll"><table>/u);
  assert.match(html, /<th>Name<\/th>/u);
  assert.match(html, /<td>Wallet<\/td>/u);
  assert.match(html, /<td>Local process<\/td>/u);
});

test("fenced code and inline markup are escaped and rendered", () => {
  const md = [
    "Use `room.send()` and **never** share a key.",
    "",
    "```js",
    'if (a < b && c > d) send("<script>");',
    "```",
    "",
    "See [the protocol](protocol.md) and [npm](https://www.npmjs.com/package/x).",
  ].join("\n");
  const { html } = renderMarkdown(md);
  assert.match(html, /<code>room\.send\(\)<\/code>/u);
  assert.match(html, /<strong>never<\/strong>/u);
  assert.match(html, /class="language-js"/u);
  assert.match(html, /a &lt; b &amp;&amp; c &gt; d/u);
  assert.doesNotMatch(html, /<script>/u);
  assert.match(html, /href="protocol\.md"/u);
  assert.match(
    html,
    /href="https:\/\/www\.npmjs\.com\/package\/x" target="_blank"/u,
  );
});

test("a docs page has the shared stylesheet, nav, table of contents and raw link", () => {
  const page = renderDocPage({
    markdown:
      "# Architecture\n\n## Components\n\n| A | B |\n| - | - |\n| 1 | 2 |\n",
    title: "Architecture",
    name: "ARCHITECTURE.md",
    docs: [
      { file: "ARCHITECTURE.md", label: "Architecture" },
      { file: "SECURITY.md", label: "Security" },
    ],
    rawPath: "./ARCHITECTURE.md",
  });
  assert.match(page, /<link rel="stylesheet" href="\.\/docs\.css">/u);
  assert.match(page, /aria-current="page"/u);
  assert.match(page, /class="toc"/u);
  assert.match(page, /href="\.\/ARCHITECTURE\.md"/u);
  assert.match(page, /<table>/u);
  assert.equal((page.match(/<h1\b/gu) ?? []).length, 1); // one title, from the shell
});

test("a docs page rewrites internal Markdown links to HTML pages", () => {
  const page = renderDocPage({
    markdown:
      "# Index\n\nSee [limits](limits.md) and [npm](https://www.npmjs.com/package/x).",
    title: "Index",
    name: "README.md",
    docs: [],
    rawPath: "./README.md",
  });
  assert.match(page, /href="limits\.html"/u);
  assert.match(page, /href="https:\/\/www\.npmjs\.com\/package\/x"/u);
});
