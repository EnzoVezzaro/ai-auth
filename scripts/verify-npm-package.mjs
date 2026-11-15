import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const [packagePath = ".", ...moduleNames] = process.argv.slice(2);
if (moduleNames.length === 0) {
  throw new Error("Pass the package directory followed by import specifiers");
}

const packageDirectory = path.resolve(repoRoot, packagePath);
const temporaryDirectory = await mkdtemp(
  path.join(tmpdir(), "ai-auth-package-check-"),
);
const consumerDirectory = path.join(temporaryDirectory, "consumer");

try {
  const packed = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--pack-destination", temporaryDirectory],
      {
        cwd: packageDirectory,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      },
    ),
  );
  const tarball = path.join(temporaryDirectory, packed[0].filename);
  await mkdir(consumerDirectory, { recursive: true });
  execFileSync(
    "npm",
    [
      "install",
      "--prefix",
      consumerDirectory,
      "--no-save",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      tarball,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const specifiers = JSON.stringify(moduleNames);
  const verify = `
    const names = ${specifiers};
    for (const name of names) {
      const module = await import(name);
      if (Object.keys(module).length === 0) throw new Error(name + " has no exports");
    }
    console.log("Installed package exports resolve:", names.join(", "));
  `;
  execFileSync("node", ["--input-type=module", "--eval", verify], {
    cwd: consumerDirectory,
    encoding: "utf8",
    stdio: ["ignore", "inherit", "inherit"],
  });
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
