import { build } from "esbuild";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  DISCOVERY_CAPABILITIES,
  DISCOVERY_PATH,
  DISCOVERY_TYPE,
  DISCOVERY_VERSION,
  MAX_DISCOVERY_BYTES,
  validateDiscovery,
} from "../packages/p2p/discovery.js";
import { renderDocPage } from "./render-docs.mjs";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "dist-p2p");
const { version } = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
// GitHub Pages' Jekyll step ignores dotfiles unless this marker is present.
// Without it .well-known/ai-auth.json is built but never published.
await writeFile(resolve(output, ".nojekyll"), "");
await mkdir(resolve(output, "wallet"), { recursive: true });
await mkdir(resolve(output, "connect-agent"), { recursive: true });
await mkdir(resolve(output, "docs"), { recursive: true });
await mkdir(resolve(output, "landing"), { recursive: true });
await cp(resolve(root, "index.html"), resolve(output, "index.html"));
await cp(resolve(root, "landing.css"), resolve(output, "landing.css"));
await cp(resolve(root, "docs.css"), resolve(output, "docs.css"));
await cp(resolve(root, "LICENSE"), resolve(output, "LICENSE"));
await mkdir(resolve(output, "docs"), { recursive: true });
await cp(resolve(root, "docs.css"), resolve(output, "docs", "docs.css"));
// Crawler files: the landing page is the only indexable page. The wallet and
// the demo are crawlable so their noindex tags can be read, and they say no.
await cp(resolve(root, "robots.txt"), resolve(output, "robots.txt"));
await cp(resolve(root, "sitemap.xml"), resolve(output, "sitemap.xml"));
// llms.txt: a plain-markdown summary for language models, served at the root.
await cp(resolve(root, "llms.txt"), resolve(output, "llms.txt"));

// Site discovery hint: a public, unsigned strict v1 document that lets a URL-
// only connect instruction yield a real room and capabilities. validateDiscovery
// is the single source of truth for the schema, so build fails on a bad hint.
// The default origin is the deployed Pages origin; override for a preview host.
const SITE_ORIGIN = new URL(
  process.env.AI_AUTH_SITE_ORIGIN ?? "https://enzovezzaro.github.io",
).origin;
const discovery = {
  type: DISCOVERY_TYPE,
  v: DISCOVERY_VERSION,
  origin: SITE_ORIGIN,
  name: "AI Auth",
  walletUrl: `${SITE_ORIGIN}/ai-auth/wallet/`,
  docsUrl: `${SITE_ORIGIN}/ai-auth/docs/agents.md`,
  capabilities: [...DISCOVERY_CAPABILITIES],
  rooms: [{ name: "default", mode: "open" }],
  webmcp: true,
};
const generated = validateDiscovery(discovery, { origin: SITE_ORIGIN });
if (!generated.ok)
  throw new Error(
    `Generated AI Auth discovery is invalid: ${generated.reason}`,
  );
const discoveryText = `${JSON.stringify(generated.discovery, null, 2)}\n`;
if (Buffer.byteLength(discoveryText) > MAX_DISCOVERY_BYTES)
  throw new Error("AI Auth discovery hint exceeds the 16 KiB fetch cap");
await mkdir(resolve(output, ".well-known"), { recursive: true });
await writeFile(resolve(output, DISCOVERY_PATH.slice(1)), discoveryText);
// GitHub Pages drops hidden files from its upload artifact. Publish the same
// hint at a visible path as a fallback; fetchDiscovery tries it after the
// standard URL.
await mkdir(resolve(output, "well-known"), { recursive: true });
await writeFile(resolve(output, "well-known", "ai-auth.json"), discoveryText);

const NOINDEX = '<meta name="robots" content="noindex, nofollow" />';
const withNoindex = (page) => {
  if (!page.includes("<head>"))
    throw new Error("page has no <head> to mark noindex");
  return page.replace("<head>", `<head>\n    ${NOINDEX}`);
};

// The landing page keeps its content in HTML and loads a small React island
// for the 3D scenes. Split chunks keep WebGL code off the first paint and let
// each scene load when it scrolls into view.
await cp(
  resolve(root, "node_modules/@designcodeio/threeui/lib-dist/style.css"),
  resolve(output, "landing/threeui.css"),
);
await build({
  entryPoints: [resolve(root, "src/landing/index.jsx")],
  outdir: resolve(output, "landing"),
  entryNames: "entry",
  chunkNames: "chunks/[name]-[hash]",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  jsx: "automatic",
  minify: true,
  sourcemap: false,
  define: { "process.env.NODE_ENV": '"production"' },
});
// Independent agent-cursor choreography. Kept separate from the React island
// so the agents can be changed without rebuilding the 3D scenes.
await build({
  entryPoints: [resolve(root, "src/landing/agents.js")],
  outfile: resolve(output, "landing/agents.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  sourcemap: false,
});
// Footer physics pile, also independent of the React island.
await build({
  entryPoints: [resolve(root, "src/landing/footer.js")],
  outfile: resolve(output, "landing/footer.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  sourcemap: false,
});
// Version the wallet assets by release, so a new deploy is never served from a
// browser cache that still holds the previous stylesheet or script.
const walletEntry = (
  await readFile(resolve(root, "apps/p2p/index.html"), "utf8")
)
  .replace('href="./styles.css"', `href="./styles.css?v=${version}"`)
  .replace('src="./app.js"', `src="./app.js?v=${version}"`)
  .replace("AI Auth Wallet v0.2.0", `AI Auth Wallet v${version}`);
await writeFile(resolve(output, "wallet/index.html"), withNoindex(walletEntry));
await cp(resolve(root, "styles.css"), resolve(output, "wallet/styles.css"));
await build({
  entryPoints: [resolve(root, "apps/p2p/app.js")],
  outfile: resolve(output, "wallet/app.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  sourcemap: false,
});
// Agent-first page: the site opens a room with its own local identity and
// publishes a link for an agent. No owner-wallet form is involved.
const connectAgentEntry = (
  await readFile(resolve(root, "apps/connect-agent/index.html"), "utf8")
)
  .replace('href="./style.css"', `href="./style.css?v=${version}"`)
  .replace('src="./app.js"', `src="./app.js?v=${version}"`);
await writeFile(
  resolve(output, "connect-agent/index.html"),
  withNoindex(connectAgentEntry),
);
await cp(
  resolve(root, "apps/connect-agent/style.css"),
  resolve(output, "connect-agent/style.css"),
);
await build({
  entryPoints: [resolve(root, "apps/connect-agent/app.js")],
  outfile: resolve(output, "connect-agent/app.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  sourcemap: false,
});
await build({
  entryPoints: [resolve(root, "packages/p2p/browser.js")],
  outfile: resolve(output, "ai-auth.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  sourcemap: false,
});

// BODY4AI reference demo site, served under /body4ai/ (used by the E2E).
const demoSource = resolve(root, "examples/body4ai/site");
await mkdir(resolve(output, "body4ai"), { recursive: true });
for (const name of ["index.html", "product.html"])
  await writeFile(
    resolve(output, "body4ai", name),
    withNoindex(await readFile(resolve(demoSource, name), "utf8")),
  );
await cp(resolve(demoSource, "site.css"), resolve(output, "body4ai/site.css"));
await build({
  entryPoints: [resolve(demoSource, "site.js")],
  outfile: resolve(output, "body4ai/site.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  sourcemap: false,
});

// External integration reference site, served under /host-site/. Source lives
// in examples/host-site. As with body4ai, site.js imports the SDK via relative
// paths that esbuild resolves at build time, so the published bundle has no
// runtime relative imports to break from dist-p2p/host-site/.
const hostSiteSource = resolve(root, "examples/host-site");
await mkdir(resolve(output, "host-site"), { recursive: true });
await writeFile(
  resolve(output, "host-site", "index.html"),
  withNoindex(await readFile(resolve(hostSiteSource, "index.html"), "utf8")),
);
await cp(
  resolve(hostSiteSource, "site.css"),
  resolve(output, "host-site/site.css"),
);
await build({
  entryPoints: [resolve(hostSiteSource, "site.js")],
  outfile: resolve(output, "host-site/site.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  sourcemap: false,
  // The site source uses ../../../packages/p2p/browser.js, an import depth that
  // is correct for body4ai (three dirs deep) but overshoots from examples/
  // host-site (two dirs deep). Resolve any packages/p2p/ specifier from the
  // repo root so the SDK is bundled regardless of the leading ../ count.
  plugins: [
    {
      name: "host-site-sdk",
      setup(b) {
        b.onResolve({ filter: /packages\/p2p\// }, (args) => {
          const rel = args.path.match(/packages\/p2p\/.*$/u)?.[0];
          return rel ? { path: resolve(root, rel) } : undefined;
        });
      },
    },
  ],
});
// The README is optional documentation, published as a plain file (not a doc
// page) so /host-site/README.md resolves without touching DOC_PAGES.
if (
  await stat(resolve(hostSiteSource, "README.md")).then(
    () => true,
    () => false,
  )
)
  await cp(
    resolve(hostSiteSource, "README.md"),
    resolve(output, "host-site/README.md"),
  );
// docs/site-integration.md links to this README; verify-docs rewrites .md
// links to .html, so publish an .html copy that resolves to the plain file.
await cp(
  resolve(hostSiteSource, "README.md"),
  resolve(output, "host-site/README.html"),
);

// Docs are rendered to styled HTML at .html URLs. The .md URLs are directories
// with an index.html, so a static host redirects them to a styled page too
// (browsers treat text/markdown as plain text). Raw Markdown moves to docs/raw/
// for llms.txt and source readers. Every doc in the index is rendered, so
// internal links such as [limits](limits.md) become .html links that resolve.
const DOC_PAGES = [
  { file: "README.md", label: "Index", nav: true },
  { file: "ARCHITECTURE.md", label: "Architecture", nav: true },
  { file: "quickstart.md", label: "Quickstart", nav: true },
  { file: "site-integration.md", label: "Site integration", nav: true },
  { file: "agents.md", label: "Agents and MCP", nav: true },
  { file: "AGENT_HARNESS_SUPPORT.md", label: "Agent harness support" },
  { file: "protocol.md", label: "Protocol", nav: true },
  { file: "SECURITY.md", label: "Security", nav: true },
  { file: "RECOVERY.md", label: "Recovery", nav: true },
  { file: "mcp.md", label: "MCP command" },
  { file: "lifecycle.md", label: "Lifecycle" },
  { file: "limits.md", label: "Limits" },
  { file: "HOSTING.md", label: "Hosting" },
  { file: "DISCOVERY.md", label: "Discovery" },
  { file: "BOUNDARIES.md", label: "Boundaries" },
  { file: "E2E.md", label: "E2E tests" },
  { file: "GENERIC_INTEGRATION_REVIEW.md", label: "Integration review" },
  { file: "TRACEABILITY.md", label: "Traceability" },
  { file: "evidence.md", label: "Evidence" },
  { file: "AGENT_E2E_PLAN.md", label: "Agent E2E plan" },
  { file: "DID.md", label: "DID alias" },
  { file: "IDENTITY_STANDARDS_REVIEW.md", label: "Identity standards review" },
  {
    file: "evidence/did-key-verification.md",
    label: "DID verification evidence",
  },
  {
    file: "evidence/decentralized-plan.md",
    label: "Decentralization evidence plan",
  },
  {
    file: "architecture/COUNCIL_REPORT.md",
    label: "Architecture council report",
  },
  {
    file: "architecture/REFERENCE_ARCHITECTURE.md",
    label: "Reference architecture",
  },
  { file: "architecture/STANDARDS_MATRIX.md", label: "Standards matrix" },
  { file: "architecture/TOOL_PROTOCOLS.md", label: "Tool protocols" },
  {
    file: "architecture/AGENT_INTEROPERABILITY.md",
    label: "Agent interoperability",
  },
  { file: "architecture/COMMERCE_PAYMENTS.md", label: "Commerce and payments" },
  { file: "architecture/THREAT_MODEL.md", label: "Threat model" },
  { file: "architecture/IMPLEMENTATION_PLAN.md", label: "Implementation plan" },
  { file: "architecture/CONFORMANCE_PLAN.md", label: "Conformance plan" },
  { file: "architecture/DECISIONS.md", label: "Architecture decisions" },
  {
    file: "INTEROPERABILITY_CODE_MODE_RFC.md",
    label: "Interoperability and Code Mode RFC",
  },
  {
    file: "CODE_MODE_COMPARISON.md",
    label: "Code Mode comparison",
  },
  {
    file: "IDENTITY_STANDARDS_RFC.md",
    label: "Identity standards RFC",
  },
  {
    file: "CONNECT_AGENT_E2E_ACCEPTANCE.md",
    label: "Connect Agent E2E acceptance",
  },
];
const navDocs = DOC_PAGES.filter((doc) => doc.nav);
await mkdir(resolve(output, "docs", "raw"), { recursive: true });
for (const doc of DOC_PAGES) {
  const markdown = await readFile(resolve(root, "docs", doc.file), "utf8");
  const title = markdown.match(/^#\s+(.+)$/mu)?.[1] ?? doc.label;
  const page = renderDocPage({
    markdown,
    title,
    name: doc.file,
    docs: navDocs,
    rawPath: `./raw/${doc.file}`,
    version,
  });
  // renderDocPage emits links relative to docs/. Nested docs such as
  // architecture/REFERENCE_ARCHITECTURE.md need one extra ../ for their
  // directory depth, and the /<name>.md/ directory variant needs one more.
  const depth = dirname(doc.file)
    .split("/")
    .filter((part) => part && part !== ".").length;
  const rebase = (html, extra) =>
    html.replace(/\b(href|src)="([^"]*)"/gu, (_, attribute, value) => {
      if (
        value.startsWith("#") ||
        value.startsWith("/") ||
        /^\w+:/u.test(value)
      )
        return `${attribute}="${value}"`;
      let up = 0;
      while (value.startsWith("../")) {
        up += 1;
        value = value.slice(3);
      }
      const target = value.startsWith("./") ? value.slice(2) : value;
      const prefix = "../".repeat(depth + extra + up);
      return `${attribute}="${prefix ? `${prefix}${target}` : `./${target}`}"`;
    });
  await mkdir(dirname(resolve(output, "docs", doc.file)), { recursive: true });
  await mkdir(dirname(resolve(output, "docs", "raw", doc.file)), {
    recursive: true,
  });
  await writeFile(
    resolve(output, "docs", doc.file.replace(/\.md$/u, ".html")),
    rebase(page, 0),
  );
  await mkdir(resolve(output, "docs", doc.file), { recursive: true });
  await writeFile(
    resolve(output, "docs", doc.file, "index.html"),
    rebase(page, 1),
  );
  await writeFile(resolve(output, "docs", "raw", doc.file), markdown);
}
// A few docs link outside docs/: publish those targets too so no page has a
// dead link. They keep their original path so ../ links resolve as written.
const EXTRA_PAGES = [
  {
    source: "README.md",
    output: "README.html",
    title: "Readme",
    depth: 0,
  },
  {
    source: "CHANGELOG.md",
    output: "CHANGELOG.html",
    title: "Changelog",
    depth: 0,
  },
  {
    source: "packages/agent/README.md",
    output: "packages/agent/README.html",
    title: "Agent package",
    depth: 2,
  },
  {
    source: "packages/mcp/README.md",
    output: "packages/mcp/README.html",
    title: "MCP package",
    depth: 2,
  },
  {
    source: "packages/runtime/README.md",
    output: "packages/runtime/README.html",
    title: "Runtime package",
    depth: 2,
  },
];
for (const extra of EXTRA_PAGES) {
  const markdown = await readFile(resolve(root, extra.source), "utf8");
  const target = resolve(output, extra.output);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(
    target,
    renderDocPage({
      markdown,
      title: extra.title,
      name: "",
      docs: [],
      rawPath: `https://github.com/EnzoVezzaro/ai-auth/blob/main/${extra.source}`,
      cssPath: `${extra.depth === 0 ? "./" : "../".repeat(extra.depth)}docs/docs.css`,
      brandPath: `${extra.depth === 0 ? "./" : "../".repeat(extra.depth)}index.html`,
      assetPath: `${extra.depth === 0 ? "./" : "../".repeat(extra.depth)}docs/assets/ai-auth-mark.svg`,
      version,
    }),
  );
}
// /docs/ serves the same index as /docs/README.html.
await cp(
  resolve(output, "docs", "README.html"),
  resolve(output, "docs", "index.html"),
);
await cp(resolve(root, "docs", "assets"), resolve(output, "docs", "assets"), {
  recursive: true,
});

const landing = await readFile(resolve(output, "index.html"), "utf8");
const wallet = await readFile(resolve(output, "wallet/index.html"), "utf8");
const landingBundle = await readFile(
  resolve(output, "landing/entry.js"),
  "utf8",
);
const agentsBundle = await readFile(
  resolve(output, "landing/agents.js"),
  "utf8",
);
const footerBundle = await readFile(
  resolve(output, "landing/footer.js"),
  "utf8",
);
const architecture = await readFile(
  resolve(output, "docs", "ARCHITECTURE.html"),
  "utf8",
);
if (
  !landing.includes('href="./wallet/"') ||
  !landing.includes('href="./docs/ARCHITECTURE.html"') ||
  !landing.includes('class="cursor-sprite"') ||
  !landing.includes('src="./landing/agents.js"') ||
  !landing.includes('src="./landing/footer.js"') ||
  !landingBundle.includes("data-scene") ||
  !agentsBundle.includes("agent-hover") ||
  !footerBundle.includes("pile-item") ||
  !wallet.includes(`src="./app.js?v=${version}"`) ||
  !wallet.includes(`href="./styles.css?v=${version}"`) ||
  !architecture.includes('href="./docs.css"') ||
  !architecture.includes("<table>") ||
  !architecture.includes('href="./raw/ARCHITECTURE.md"')
) {
  throw new Error("Static landing or docs page has a broken asset reference");
}
// Assert the published hint is still a strict v1 document after serialization.
const publishedDiscovery = JSON.parse(
  await readFile(resolve(output, DISCOVERY_PATH.slice(1)), "utf8"),
);
const published = validateDiscovery(publishedDiscovery, {
  origin: SITE_ORIGIN,
});
if (
  !published.ok ||
  publishedDiscovery.type !== DISCOVERY_TYPE ||
  publishedDiscovery.v !== DISCOVERY_VERSION ||
  publishedDiscovery.origin !== SITE_ORIGIN ||
  !Array.isArray(publishedDiscovery.capabilities) ||
  publishedDiscovery.capabilities.length === 0 ||
  !publishedDiscovery.rooms?.length ||
  publishedDiscovery.webmcp !== true
)
  throw new Error("Published AI Auth discovery hint is invalid");
await writeFile(
  resolve(output, "BUILD_INFO.json"),
  JSON.stringify(
    {
      app: "AI Auth",
      version,
      routes: ["/", "/wallet/", "/docs/", DISCOVERY_PATH],
      serverFunctions: 0,
    },
    null,
    2,
  ),
);
console.log(`Static AI Auth site built to ${output}`);
