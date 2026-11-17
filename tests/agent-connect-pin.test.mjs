import assert from "node:assert/strict";
import test from "node:test";
import { createAIAuthConnectInstruction } from "../packages/p2p/agent-connect.js";

const OPTIONS = {
  siteOrigin: "https://site.example",
  walletUrl: "https://wallet.example/wallet/",
  capabilities: ["presence.read", "messages.send"],
};

test("the copyable connect instruction pins the published SDK version", () => {
  const { instruction } = createAIAuthConnectInstruction(OPTIONS);
  const importLine = instruction
    .split("\n")
    .find((line) => line.startsWith("import { connectAIAuthModal }"));
  assert.ok(importLine, "the instruction has a copyable SDK import");
  assert.match(
    importLine,
    /@enzovezzaro\/ai-auth-wallet@0\.9\.1/u,
    "the import pins the exact published version",
  );
  assert.doesNotMatch(
    importLine,
    /ai-auth-wallet(?![@/])/u,
    "no unpinned bare package specifier remains in the copyable import",
  );
});
