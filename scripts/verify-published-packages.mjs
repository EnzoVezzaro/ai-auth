import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const legacyWalletExports = {
  "@enzovezzaro/ai-auth-wallet": [
    "canonicalize",
    "randomNonce",
    "identityFor",
    "createWallet",
    "loadWallet",
    "importWalletBackup",
    "forgetWallet",
    "downloadBackup",
    "signEnvelope",
    "verifyEnvelope",
    "appendActivity",
    "readActivity",
    "MAX_EVENT_AGE_MS",
    "MAX_SEEN_EVENTS",
    "NonceGuard",
    "createPermissionRequest",
    "approvePermissionRequest",
    "verifyPermissionRequest",
    "verifyPopupPermissionRequest",
    "verifyPermissionConsent",
    "createCapabilityGrant",
    "verifyCapabilityGrant",
    "P2PRoom",
    "ManualWebRTC",
  ],
  "@enzovezzaro/ai-auth-wallet/wallet": [
    "canonicalize",
    "createWallet",
    "downloadBackup",
    "forgetWallet",
    "identityFor",
    "importWalletBackup",
    "loadWallet",
    "randomNonce",
    "readActivity",
    "appendActivity",
    "signEnvelope",
    "verifyEnvelope",
  ],
  "@enzovezzaro/ai-auth-wallet/connect": [
    "NonceGuard",
    "createPermissionRequest",
    "approvePermissionRequest",
    "verifyPermissionRequest",
    "verifyPopupPermissionRequest",
    "verifyPermissionConsent",
  ],
  "@enzovezzaro/ai-auth-wallet/capabilities": [
    "createCapabilityGrant",
    "verifyCapabilityGrant",
  ],
  "@enzovezzaro/ai-auth-wallet/p2p": ["P2PRoom", "ManualWebRTC"],
};

const availableChecks = [
  {
    name: "@enzovezzaro/ai-auth-wallet@stable",
    package: "@enzovezzaro/ai-auth-wallet@0.1.1",
    imports: Object.keys(legacyWalletExports),
    expectedExports: legacyWalletExports,
  },
  {
    name: "@enzovezzaro/ai-auth-wallet",
    package: "@enzovezzaro/ai-auth-wallet@next",
    imports: [
      "@enzovezzaro/ai-auth-wallet",
      "@enzovezzaro/ai-auth-wallet/wallet",
      "@enzovezzaro/ai-auth-wallet/connect",
      "@enzovezzaro/ai-auth-wallet/capabilities",
      "@enzovezzaro/ai-auth-wallet/p2p",
      "@enzovezzaro/ai-auth-wallet/service",
    ],
    expectedExports: legacyWalletExports,
  },
  {
    name: "@enzovezzaro/ai-auth-mcp",
    package: "@enzovezzaro/ai-auth-mcp@next",
    imports: ["@enzovezzaro/ai-auth-mcp"],
  },
  {
    name: "@enzovezzaro/ai-auth-runtime",
    package: "@enzovezzaro/ai-auth-runtime@next",
    imports: ["@enzovezzaro/ai-auth-runtime"],
  },
];
const requestedPackages = process.argv.slice(2);
const checks = requestedPackages.length
  ? availableChecks.filter((check) => requestedPackages.includes(check.name))
  : availableChecks;
if (checks.length === 0)
  throw new Error("No matching published package checks were selected");
const temporaryDirectory = await mkdtemp(
  path.join(tmpdir(), "ai-auth-published-check-"),
);

try {
  for (const [index, check] of checks.entries()) {
    const consumerDirectory = path.join(
      temporaryDirectory,
      `consumer-${index}`,
    );
    await mkdir(consumerDirectory, { recursive: true });
    const version = execFileSync(
      "npm",
      ["view", check.package, "version", "--json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    ).trim();
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
        check.package,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    );
    const imports = JSON.stringify(check.imports);
    const expectedExports = JSON.stringify(check.expectedExports ?? {});
    const verify = `
      for (const name of ${imports}) {
        const module = await import(name);
        if (Object.keys(module).length === 0) throw new Error(name + " has no exports");
        const missing = (${expectedExports})[name]?.filter((key) => !(key in module)) ?? [];
        if (missing.length) throw new Error(name + " is missing legacy exports: " + missing.join(", "));
      }
      console.log("Installed", ${JSON.stringify(check.package)}, "version", ${version}, "and resolved its exports");
    `;
    execFileSync("node", ["--input-type=module", "--eval", verify], {
      cwd: consumerDirectory,
      encoding: "utf8",
      stdio: ["ignore", "inherit", "inherit"],
    });
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
