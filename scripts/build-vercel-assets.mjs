import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as prettier from "prettier";

const assets = {
  home: "index.html",
  docs: "docs/index.html",
  dashboard: "apps/dashboard/index.html",
  demo: "apps/demo-website/index.html",
  sdk: "packages/sdk/ai-auth.js",
};
const entries = [];
for (const [name, path] of Object.entries(assets)) {
  entries.push(`  ${name}: ${JSON.stringify(await readFile(path, "utf8"))},`);
}
await mkdir("apps/server/src", { recursive: true });
const generated = await prettier.format(
  `export const webAssets = {\n${entries.join("\n")}\n};\n`,
  { filepath: "apps/server/src/web-assets.generated.ts" },
);
await writeFile(
  "apps/server/src/web-assets.generated.ts",
  generated,
);
await rm("public", { recursive: true, force: true });
