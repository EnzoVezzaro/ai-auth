// Guard the repository's intentional GitHub Pages-only deployment contract.
// This cannot revoke an external GitHub App; see docs/HOSTING.md.
import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const exists = async (path) => {
  try {
    await access(resolve(root, path));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
};

const legacy = ["vercel.json", "now.json", ".vercel", ".vercelignore"];
const found = [];
for (const path of legacy) if (await exists(path)) found.push(path);

const workflows = await readdir(resolve(root, ".github/workflows"));
for (const name of workflows) {
  if (!/\.ya?ml$/u.test(name)) continue;
  const path = `.github/workflows/${name}`;
  if (/vercel/iu.test(name)) found.push(path);
  const content = await readFile(resolve(root, path), "utf8");
  if (/\bvercel\b/iu.test(content)) found.push(`${path} (Vercel integration)`);
}
assert.deepEqual(found, [], `Unexpected Vercel deployment configuration: ${found.join(", ")}`);

const pages = await readFile(resolve(root, ".github/workflows/pages.yml"), "utf8");
for (const required of [
  "branches: [main]",
  "actions/configure-pages@",
  "actions/upload-pages-artifact@",
  "actions/deploy-pages@",
  "path: dist-p2p",
  "name: github-pages",
]) assert.ok(pages.includes(required), `GitHub Pages contract missing: ${required}`);

console.log("Hosting verified: only GitHub Pages deployment is configured in this repository.");
