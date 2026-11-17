// Small, dependency-free Markdown to HTML renderer for the published docs.
// It covers the subset used in docs/*.md: headings, paragraphs, lists,
// blockquotes, fenced code, pipe tables, rules, and common inline markup.

const HTML_ESCAPES = Object.freeze({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (char) => HTML_ESCAPES[char]);
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[`*_[\]()]/gu, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/gu, "-");
}

function inline(text, rewriteMdLinks = false) {
  const code = [];
  let out = String(text).replace(/`([^`]+)`/gu, (_, body) => {
    code.push(`<code>${escapeHtml(body)}</code>`);
    return `\u0000c${code.length - 1}\u0000`;
  });
  out = escapeHtml(out);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/gu, (_, label, rawUrl) => {
    let url = rawUrl.replace(/&amp;/gu, "&");
    const external = /^https?:\/\//u.test(url);
    if (rewriteMdLinks && !external && url.endsWith(".md"))
      url = url.replace(/\.md$/u, ".html");
    return `<a href="${escapeHtml(url)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${label}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/gu, "<strong>$1</strong>");
  out = out.replace(/(^|[^*\w])\*([^*]+)\*/gu, "$1<em>$2</em>");
  return out.replace(/\u0000c(\d+)\u0000/gu, (_, index) => code[Number(index)]);
}

function cells(line) {
  return line
    .trim()
    .replace(/^\|/u, "")
    .replace(/\|$/u, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isRule(line) {
  return /^\s*(?:[-*_]\s*){3,}$/u.test(line);
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/u.test(line);
}

/**
 * Render Markdown to HTML. Returns the article HTML and the headings used for
 * a table of contents.
 */
export function renderMarkdown(markdown, { rewriteMdLinks = false } = {}) {
  const lines = String(markdown).replace(/\r\n/gu, "\n").split("\n");
  const out = [];
  const headings = [];
  const renderInline = (text) => inline(text, rewriteMdLinks);
  let index = 0;

  const flushParagraph = (buf) => {
    if (!buf.length) return;
    out.push(`<p>${renderInline(buf.join(" "))}</p>`);
    buf.length = 0;
  };

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const fence = line.match(/^\s*```\s*([\w-]*)\s*$/u);
    if (fence) {
      const language = fence[1];
      const body = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/u.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      out.push(
        `<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ""}>${escapeHtml(body.join("\n"))}</code></pre>`,
      );
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/u);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2];
      const id = slugify(title);
      headings.push({ level, title, id });
      out.push(
        `<h${level} id="${escapeHtml(id)}">${renderInline(title)}<a class="anchor" href="#${escapeHtml(id)}" aria-label="Link to this section">#</a></h${level}>`,
      );
      index += 1;
      continue;
    }

    if (isRule(line)) {
      out.push("<hr>");
      index += 1;
      continue;
    }

    // Pipe table: header row, alignment row, then body rows.
    if (line.includes("|") && isTableSeparator(lines[index + 1] ?? "")) {
      const head = cells(line);
      const aligns = cells(lines[index + 1]).map((cell) => {
        const left = cell.startsWith(":");
        const right = cell.endsWith(":");
        if (left && right) return "center";
        if (right) return "right";
        if (left) return "left";
        return "";
      });
      const style = (i) =>
        aligns[i] ? ` style="text-align:${aligns[i]}"` : "";
      const body = [];
      index += 2;
      while (
        index < lines.length &&
        lines[index].includes("|") &&
        lines[index].trim() !== ""
      ) {
        body.push(cells(lines[index]));
        index += 1;
      }
      const thead = head
        .map((cell, i) => `<th${style(i)}>${renderInline(cell)}</th>`)
        .join("");
      const tbody = body
        .map(
          (row) =>
            `<tr>${head.map((_, i) => `<td${style(i)}>${renderInline(row[i] ?? "")}</td>`).join("")}</tr>`,
        )
        .join("");
      out.push(
        `<div class="table-scroll"><table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>`,
      );
      continue;
    }

    if (/^\s*>\s?/u.test(line)) {
      const body = [];
      while (index < lines.length && /^\s*>\s?/u.test(lines[index])) {
        body.push(lines[index].replace(/^\s*>\s?/u, ""));
        index += 1;
      }
      out.push(`<blockquote>${renderInline(body.join(" "))}</blockquote>`);
      continue;
    }

    const list = line.match(/^\s*(?:([-*])\s+|\d+\.\s+)(.+)$/u);
    if (list) {
      const ordered = !list[1];
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*(?:[-*]\s+|\d+\.\s+)(.+)$/u);
        if (item) {
          items.push(item[1]);
          index += 1;
          continue;
        }
        // An indented, non-marker line continues the previous list item.
        const continuation = lines[index].match(/^\s{2,}(\S.*)$/u);
        if (continuation && items.length) {
          items[items.length - 1] += ` ${continuation[1].trim()}`;
          index += 1;
          continue;
        }
        break;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(
        `<${tag}>${items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</${tag}>`,
      );
      continue;
    }

    // Plain paragraph: gather until a blank line or another block starts.
    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length) {
      const next = lines[index];
      if (
        next.trim() === "" ||
        /^\s*#{1,6}\s/u.test(next) ||
        /^\s*```/u.test(next) ||
        /^\s*>\s?/u.test(next) ||
        /^\s*(?:[-*]\s+|\d+\.\s+)/u.test(next) ||
        isRule(next) ||
        (next.includes("|") && isTableSeparator(lines[index + 1] ?? ""))
      )
        break;
      paragraph.push(next.trim());
      index += 1;
    }
    flushParagraph(paragraph);
  }

  return { html: out.join("\n"), headings };
}

function toc(headings) {
  const links = headings
    .filter((h) => h.level === 2 || h.level === 3)
    .map(
      (h) =>
        `<a class="toc-${h.level}" href="#${escapeHtml(h.id)}">${inline(h.title)}</a>`,
    )
    .join("\n");
  return links
    ? `<nav class="toc" aria-label="On this page">${links}</nav>`
    : "";
}

/** Wrap rendered Markdown in the shared docs page shell. */
export function renderDocPage({ markdown, title, name, docs, rawPath }) {
  // The shell already renders the document title as the page h1.
  const body = String(markdown).replace(/^\s*#\s+.+(?:\n|$)/u, "");
  const { html, headings } = renderMarkdown(body, { rewriteMdLinks: true });
  const nav = docs
    .map(
      (doc) =>
        `<a href="${escapeHtml(doc.file)}"${doc.file === name ? ' aria-current="page"' : ""}>${escapeHtml(doc.label)}</a>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — AI Auth docs</title>
<link rel="stylesheet" href="./docs.css">
</head>
<body>
<a class="skip-link" href="#content">Skip to content</a>
<header class="site-header">
  <a class="brand" href="../index.html"><span class="mark" aria-hidden="true"></span>AI Auth <span class="brand-dim">/ docs</span></a>
  <nav class="primary" aria-label="Documentation">
${nav}
  </nav>
</header>
<div class="layout">
  <main id="content" class="article">
    <p class="eyebrow">Documentation</p>
    <h1 class="page-title">${escapeHtml(title)}</h1>
${html}
    <footer class="doc-footer">
      <a href="${escapeHtml(rawPath)}">View raw Markdown</a>
      <span>AI Auth · self-custodied identity, no server</span>
    </footer>
  </main>
${toc(headings)}
</div>
</body>
</html>
`;
}
