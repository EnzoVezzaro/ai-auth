import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { INLINE_WALLET_NOTICE } from "../packages/p2p/copy.js";
import { inlineCreateWalletForm } from "../packages/p2p/wallet-setup-copy.js";

test("R3 the no-wallet request screen renders an inline Create wallet action", () => {
  const html = inlineCreateWalletForm({ error: "" });
  assert.match(html, /id="create-wallet-form"/u);
  assert.match(html, /name="name"/u);
  assert.match(html, /name="passphrase"/u);
  assert.match(html, /name="confirmation"/u);
  assert.match(html, /Create wallet/u);
  assert.doesNotMatch(html, /Create your wallet first/u);
  assert.doesNotMatch(html, /Continue to wallet setup/u);
  assert.doesNotMatch(html, /Open identity setup/u);
});

test("R3 the inline form keeps the existing wallet look and shows errors", () => {
  const html = inlineCreateWalletForm({ error: "Passphrases do not match" });
  assert.match(html, /class="panel"/u);
  assert.match(html, /class="button"/u);
  assert.match(html, /role="alert"/u);
  assert.match(html, /Passphrases do not match/u);
});

test("R3 the copy invites an inline action instead of a dead end", () => {
  assert.match(INLINE_WALLET_NOTICE, /Create a wallet here/u);
  assert.doesNotMatch(INLINE_WALLET_NOTICE, /Create your wallet first/u);
});

test("R3 the wallet request view uses the inline form and drops the redirect", async () => {
  const source = await readFile(
    new URL("../apps/p2p/app.js", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function externalPermissionView()");
  const end = source.indexOf("function walletRequired()");
  assert.ok(start > -1 && end > start, "the request view is present");
  const branch = source.slice(start, end);
  assert.match(branch, /inlineCreateWalletForm/u);
  assert.doesNotMatch(branch, /NO_WALLET_NOTICE/u);
  assert.doesNotMatch(branch, /data-go-wallet/u);
});
