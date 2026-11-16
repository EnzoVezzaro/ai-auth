// Rewrites `file:` dependencies to caret ranges while a package is packed or
// published, then restores the repository copy. Local development keeps the
// `file:` links; the tarball and the registry manifest get real semver ranges.
//
// package.json scripts:
//   "prepack":  "node ../../scripts/pin-local-deps.mjs pin"
//   "postpack": "node ../../scripts/pin-local-deps.mjs restore"

import { copyFile, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BACKUP_NAME = ".pin-local-deps.orig.json";
const FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];

// Returns a copy of `manifest` with every `file:` spec replaced by `^<version>`.
// `versionOf(relativePath, name)` must return the version of the local package.
export function pinManifest(manifest, versionOf) {
  const pinned = structuredClone(manifest);
  const changes = {};
  for (const field of FIELDS) {
    const deps = pinned[field];
    if (!deps) continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== "string" || !spec.startsWith("file:")) continue;
      deps[name] = `^${versionOf(spec.slice("file:".length), name)}`;
      changes[`${field}.${name}`] = { from: spec, to: deps[name] };
    }
  }
  return { pinned, changes };
}

async function localVersion(directory, relative, name) {
  const target = path.resolve(directory, relative, "package.json");
  const manifest = JSON.parse(await readFile(target, "utf8"));
  if (manifest.name !== name) {
    throw new Error(`${relative} is ${manifest.name}, expected ${name}`);
  }
  return manifest.version;
}

export async function run(mode, directory = process.cwd()) {
  const manifestPath = path.join(directory, "package.json");
  const backupPath = path.join(directory, BACKUP_NAME);
  if (mode === "restore") {
    try {
      await copyFile(backupPath, manifestPath);
      await rm(backupPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return null;
  }
  if (mode !== "pin") throw new Error(`unknown mode: ${mode}`);
  const original = await readFile(manifestPath, "utf8");
  const versions = new Map();
  const manifest = JSON.parse(original);
  for (const field of FIELDS) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (typeof spec === "string" && spec.startsWith("file:")) {
        const rel = spec.slice("file:".length);
        versions.set(
          `${rel}|${name}`,
          await localVersion(directory, rel, name),
        );
      }
    }
  }
  const { pinned, changes } = pinManifest(manifest, (rel, name) =>
    versions.get(`${rel}|${name}`),
  );
  if (Object.keys(changes).length === 0) return changes;
  await writeFile(backupPath, original);
  await writeFile(manifestPath, `${JSON.stringify(pinned, null, 2)}\n`);
  return changes;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const changes = await run(process.argv[2]);
  if (changes) console.log("pinned", JSON.stringify(changes));
}
