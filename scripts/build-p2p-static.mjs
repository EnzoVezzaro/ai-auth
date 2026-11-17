import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "dist-p2p");
const { version } = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);

await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, "wallet"), { recursive: true });
await mkdir(resolve(output, "docs"), { recursive: true });
await mkdir(resolve(output, "landing"), { recursive: true });
await cp(resolve(root, "index.html"), resolve(output, "index.html"));
await cp(resolve(root, "landing.css"), resolve(output, "landing.css"));
// Crawler files: the landing page is the only indexable page. The wallet and
// the demo are crawlable so their noindex tags can be read, and they say no.
await cp(resolve(root, "robots.txt"), resolve(output, "robots.txt"));
await cp(resolve(root, "sitemap.xml"), resolve(output, "sitemap.xml"));
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

for (const name of [
  "ARCHITECTURE.md",
  "SECURITY.md",
  "WIRE_FORMAT.md",
  "RECOVERY.md",
]) {
  await cp(resolve(root, "docs", name), resolve(output, "docs", name));
}

const landing = await readFile(resolve(output, "index.html"), "utf8");
const wallet = await readFile(resolve(output, "wallet/index.html"), "utf8");
const landingBundle = await readFile(
  resolve(output, "landing/entry.js"),
  "utf8",
);
if (
  !landing.includes('href="./wallet/"') ||
  !landing.includes('href="./docs/ARCHITECTURE.md"') ||
  !landing.includes('src="./landing/entry.js"') ||
  !landingBundle.includes("data-scene") ||
  !wallet.includes(`src="./app.js?v=${version}"`) ||
  !wallet.includes(`href="./styles.css?v=${version}"`)
) {
  throw new Error("Static landing page has a broken asset reference");
}
await writeFile(
  resolve(output, "BUILD_INFO.json"),
  JSON.stringify(
    {
      app: "AI Auth",
      version,
      routes: ["/", "/wallet/", "/docs/"],
      serverFunctions: 0,
    },
    null,
    2,
  ),
);
console.log(`Static AI Auth site built to ${output}`);
