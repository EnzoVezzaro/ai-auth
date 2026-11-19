// Packs every AI Auth package and installs the tarballs together into a clean
// consumer project, then imports each public entry point.
//
// `file:` dependencies are pinned to version ranges only for the duration of
// the pack and restored in `finally`, so a failure cannot leave the repository
// with rewritten manifests. Installing the set together lets the ranges resolve
// to the local tarballs, so verification does not depend on registry state.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BACKUP_NAME, run as pinLocalDeps } from "./pin-local-deps.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const PACKAGES = [
  {
    dir: ".",
    imports: [
      "@enzovezzaro/ai-auth-wallet",
      "@enzovezzaro/ai-auth-wallet/agent-connect",
      "@enzovezzaro/ai-auth-wallet/tool-descriptor",
      "@enzovezzaro/ai-auth-wallet/tool-registry",
      "@enzovezzaro/ai-auth-wallet/unified-tools",
      "@enzovezzaro/ai-auth-wallet/provider-adapters",
      "@enzovezzaro/ai-auth-wallet/utcp-adapter",
      "@enzovezzaro/ai-auth-wallet/agent-interop",
      "@enzovezzaro/ai-auth-wallet/commerce-boundary",
    ],
  },
  { dir: "packages/runtime", imports: ["@enzovezzaro/ai-auth-runtime"] },
  { dir: "packages/agent", imports: ["@enzovezzaro/ai-auth-agent"] },
  { dir: "packages/mcp", imports: ["@enzovezzaro/ai-auth-mcp"] },
];

async function packOne(directory, destination) {
  const absolute = path.resolve(repoRoot, directory);
  const changes = await pinLocalDeps("pin", absolute);
  const hasPins = Object.keys(changes).length > 0;
  try {
    const out = execFileSync(
      "npm",
      ["pack", "--json", "--pack-destination", destination],
      { cwd: absolute, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    );
    // Lifecycle scripts print banners to stdout before the JSON array.
    const [entry] = JSON.parse(out.slice(out.lastIndexOf("\n[") + 1));
    return path.join(destination, entry.filename);
  } finally {
    if (hasPins) await pinLocalDeps("restore", absolute);
  }
}

function assertRestored(directory) {
  const backup = path.join(path.resolve(repoRoot, directory), BACKUP_NAME);
  if (existsSync(backup))
    throw new Error(`${directory}: pin backup left behind`);
}

const temporary = await mkdtemp(path.join(tmpdir(), "ai-auth-package-set-"));
try {
  const tarballs = [];
  for (const pkg of PACKAGES) {
    tarballs.push(await packOne(pkg.dir, temporary));
    assertRestored(pkg.dir);
  }
  const consumer = path.join(temporary, "consumer");
  await mkdir(consumer, { recursive: true });
  await writeFile(
    path.join(consumer, "package.json"),
    JSON.stringify({ name: "ai-auth-consumer", private: true, type: "module" }),
  );
  execFileSync(
    "npm",
    [
      "install",
      "--no-save",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      ...tarballs,
    ],
    { cwd: consumer, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const specifiers = PACKAGES.flatMap((pkg) => pkg.imports);
  const script = `
    const names = ${JSON.stringify(specifiers)};
    for (const name of names) {
      const module = await import(name);
      if (Object.keys(module).length === 0) throw new Error(name + " has no exports");
    }
    console.log("Installed package exports resolve:", names.join(", "));
  `;
  execFileSync("node", ["--input-type=module", "--eval", script], {
    cwd: consumer,
    encoding: "utf8",
    stdio: ["ignore", "inherit", "inherit"],
  });
} finally {
  await rm(temporary, { recursive: true, force: true });
}
