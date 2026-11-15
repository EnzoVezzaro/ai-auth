import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "dist-p2p");
const { version } = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);

await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, "packages/p2p"), { recursive: true });
await mkdir(resolve(output, "docs"), { recursive: true });
await cp(resolve(root, "index.html"), resolve(output, "index.html"));
await cp(resolve(root, "styles.css"), resolve(output, "styles.css"));
await cp(resolve(root, "apps/p2p/app.js"), resolve(output, "app.js"));
await cp(resolve(root, "packages/p2p"), resolve(output, "packages/p2p"), {
  recursive: true,
});

for (const name of [
  "ARCHITECTURE.md",
  "SECURITY.md",
  "WIRE_FORMAT.md",
  "RECOVERY.md",
]) {
  await cp(resolve(root, "docs", name), resolve(output, "docs", name));
}

const html = await readFile(resolve(output, "index.html"), "utf8");
if (!html.includes('src="/app.js"') || !html.includes('href="/styles.css"')) {
  throw new Error("Wallet entry page has a broken static asset reference");
}
await writeFile(
  resolve(output, "BUILD_INFO.json"),
  JSON.stringify(
    { app: "AI Auth Wallet", version, serverFunctions: 0 },
    null,
    2,
  ),
);
console.log(`Static AI Auth Wallet built to ${output}`);
