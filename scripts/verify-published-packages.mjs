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
    const isWalletPackage = Boolean(
      check.expectedExports?.["@enzovezzaro/ai-auth-wallet"],
    );
    const verify = `
      import { strict as assert } from "node:assert";
      import { webcrypto } from "node:crypto";
      globalThis.crypto ??= webcrypto;
      for (const name of ${imports}) {
        const module = await import(name);
        if (Object.keys(module).length === 0) throw new Error(name + " has no exports");
        const missing = (${expectedExports})[name]?.filter((key) => !(key in module)) ?? [];
        if (missing.length) throw new Error(name + " is missing legacy exports: " + missing.join(", "));
      }
      if (${isWalletPackage}) {
        const walletApi = await import("@enzovezzaro/ai-auth-wallet");
        const connectApi = await import("@enzovezzaro/ai-auth-wallet/connect");
        const capabilityApi = await import("@enzovezzaro/ai-auth-wallet/capabilities");
        const keys = await crypto.subtle.generateKey(
          { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]
        );
        const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
        const identity = {
          id: await walletApi.identityFor(publicKey),
          publicKey,
          privateKey: keys.privateKey,
        };
        const envelope = await walletApi.signEnvelope(identity, "compatibility/probe", { value: 1 });
        assert.equal(await walletApi.verifyEnvelope(envelope, { expectedIssuer: identity.id }), true);
        assert.equal(await walletApi.verifyEnvelope({ ...envelope, body: { ...envelope.body, payload: { value: 2 } } }), false);

        const request = await connectApi.createPermissionRequest(
          "https://compatibility.example",
          ["messages.send", "presence.read"]
        );
        assert.equal(await connectApi.verifyPermissionRequest(request, { expectedOrigin: request.audience }), true);
        const consent = await connectApi.approvePermissionRequest(identity, request, ["messages.send"]);
        const consentGuard = new connectApi.NonceGuard();
        const consentOptions = {
          expectedOrigin: request.audience,
          expectedWallet: identity.id,
          nonceGuard: consentGuard,
        };
        assert.equal(await connectApi.verifyPermissionConsent(consent, request, consentOptions), true);
        assert.equal(await connectApi.verifyPermissionConsent(consent, request, consentOptions), false);

        const grant = await capabilityApi.createCapabilityGrant(identity, {
          recipient: "agent:recipient",
          resource: "room:compatibility",
          capabilities: ["messages.send"],
          expiresAt: Date.now() + 60_000,
        });
        const grantOptions = {
          expectedIssuer: identity.id,
          expectedRecipient: "agent:recipient",
          resource: "room:compatibility",
          requiredCapability: "messages.send",
        };
        assert.equal(await capabilityApi.verifyCapabilityGrant(grant, grantOptions), true);
        assert.equal(await capabilityApi.verifyCapabilityGrant(grant, { ...grantOptions, expectedRecipient: "agent:other" }), false);
        console.log("Wallet behavior passed: signed envelope, tamper rejection, scoped consent, replay rejection, and delegated grant checks");
      }
      console.log("Installed", ${JSON.stringify(check.package)}, "version", ${version}, "and resolved its exports");
    `;
    execFileSync("node", ["--input-type=module", "--eval", verify], {
      cwd: consumerDirectory,
      encoding: "utf8",
      stdio: ["ignore", "inherit", "inherit"],
    });
  }

  if (
    checks.some(
      (check) => check.name === "@enzovezzaro/ai-auth-wallet@stable",
    ) &&
    checks.some((check) => check.name === "@enzovezzaro/ai-auth-wallet")
  ) {
    const compatibilityDirectory = path.join(
      temporaryDirectory,
      "cross-version-consumer",
    );
    await mkdir(compatibilityDirectory, { recursive: true });
    execFileSync(
      "npm",
      [
        "install",
        "--prefix",
        compatibilityDirectory,
        "--no-save",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "stable-wallet@npm:@enzovezzaro/ai-auth-wallet@0.1.1",
        "next-wallet@npm:@enzovezzaro/ai-auth-wallet@next",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    );
    const verifyInterop = `
      import { strict as assert } from "node:assert";
      import { webcrypto } from "node:crypto";
      import * as stable from "stable-wallet";
      import * as preview from "next-wallet";
      import * as stableConnect from "stable-wallet/connect";
      import * as previewConnect from "next-wallet/connect";
      import * as stableCapabilities from "stable-wallet/capabilities";
      import * as previewCapabilities from "next-wallet/capabilities";
      globalThis.crypto ??= webcrypto;

      const keys = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]
      );
      const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
      const issuer = await stable.identityFor(publicKey);
      assert.equal(await preview.identityFor(publicKey), issuer);
      const identity = { id: issuer, publicKey, privateKey: keys.privateKey };

      const stableEnvelope = await stable.signEnvelope(identity, "compatibility/cross-version", { value: "stable" });
      const previewEnvelope = await preview.signEnvelope(identity, "compatibility/cross-version", { value: "preview" });
      assert.equal(await preview.verifyEnvelope(stableEnvelope, { expectedIssuer: issuer }), true);
      assert.equal(await stable.verifyEnvelope(previewEnvelope, { expectedIssuer: issuer }), true);

      const stableRequest = await stableConnect.createPermissionRequest(
        "https://compatibility.example", ["messages.send", "presence.read"]
      );
      assert.equal(await previewConnect.verifyPermissionRequest(stableRequest, { expectedOrigin: stableRequest.audience }), true);
      const previewConsent = await previewConnect.approvePermissionRequest(identity, stableRequest, ["messages.send"]);
      const stableConsentGuard = new stableConnect.NonceGuard();
      const stableConsentOptions = {
        expectedOrigin: stableRequest.audience,
        expectedWallet: issuer,
        nonceGuard: stableConsentGuard,
      };
      assert.equal(await stableConnect.verifyPermissionConsent(previewConsent, stableRequest, stableConsentOptions), true);
      assert.equal(await stableConnect.verifyPermissionConsent(previewConsent, stableRequest, stableConsentOptions), false);

      const previewRequest = await previewConnect.createPermissionRequest(
        "https://compatibility.example", ["messages.send"]
      );
      const stableConsent = await stableConnect.approvePermissionRequest(identity, previewRequest, ["messages.send"]);
      assert.equal(await previewConnect.verifyPermissionConsent(stableConsent, previewRequest, {
        expectedOrigin: previewRequest.audience,
        expectedWallet: issuer,
        nonceGuard: new previewConnect.NonceGuard(),
      }), true);
      await assert.rejects(() => previewConnect.approvePermissionRequest(identity, previewRequest, ["presence.read"]));

      const grantInput = {
        recipient: "agent:recipient",
        resource: "room:compatibility",
        capabilities: ["messages.send"],
        expiresAt: Date.now() + 60_000,
      };
      const stableGrant = await stableCapabilities.createCapabilityGrant(identity, grantInput);
      const previewGrant = await previewCapabilities.createCapabilityGrant(identity, grantInput);
      const grantOptions = {
        expectedIssuer: issuer,
        expectedRecipient: "agent:recipient",
        resource: "room:compatibility",
        requiredCapability: "messages.send",
      };
      assert.equal(await previewCapabilities.verifyCapabilityGrant(stableGrant, grantOptions), true);
      assert.equal(await stableCapabilities.verifyCapabilityGrant(previewGrant, grantOptions), true);
      assert.equal(await previewCapabilities.verifyCapabilityGrant(stableGrant, { ...grantOptions, expectedRecipient: "agent:other" }), false);
      console.log("Stable 0.1.1 and beta wallet interoperate across signatures, scoped consent, replay protection, and delegated grants");
    `;
    execFileSync("node", ["--input-type=module", "--eval", verifyInterop], {
      cwd: compatibilityDirectory,
      encoding: "utf8",
      stdio: ["ignore", "inherit", "inherit"],
    });
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
