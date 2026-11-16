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
await cp(resolve(root, "index.html"), resolve(output, "index.html"));
await cp(resolve(root, "landing.css"), resolve(output, "landing.css"));
await cp(
  resolve(root, "apps/p2p/index.html"),
  resolve(output, "wallet/index.html"),
);
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
for (const name of ["index.html", "product.html", "site.css"])
  await cp(resolve(demoSource, name), resolve(output, "body4ai", name));
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
if (
  !landing.includes('href="./wallet/"') ||
  !landing.includes('href="./docs/ARCHITECTURE.md"') ||
  !wallet.includes('src="./app.js"') ||
  !wallet.includes('href="./styles.css"')
) {
  throw new Error("Wallet entry page has a broken static asset reference");
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
