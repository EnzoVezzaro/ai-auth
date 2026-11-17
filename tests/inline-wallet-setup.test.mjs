import assert from "node:assert/strict";
import test from "node:test";
import { INLINE_WALLET_NOTICE } from "../packages/p2p/copy.js";
import { inlineCreateWalletForm } from "../packages/p2p/wallet-setup-copy.js";
import {
  appSource,
  extractFunction,
  runFragment,
} from "./helpers/app-source.mjs";

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
  // Run the real view with no wallet instead of grepping a source slice.
  const view = extractFunction(await appSource(), "externalPermissionView");
  const sandbox = runFragment(view, {
    state: {
      wallet: null,
      error: "",
      externalRequest: {
        audience: "https://site.example",
        capabilities: ["presence.read"],
      },
    },
    pageHead: (_title, _subtitle, body) => body,
    esc: (value) => String(value),
    capabilityCopy: () => ({ title: "Read presence" }),
    INLINE_WALLET_NOTICE,
    inlineCreateWalletForm,
  });
  const html = sandbox.externalPermissionView();
  assert.match(html, /id="create-wallet-form"/u, "the inline form is rendered");
  assert.match(html, /Create a wallet here/u, "the inline notice is shown");
  assert.doesNotMatch(html, /data-go-wallet/u, "no redirect-to-wallet button");
  assert.doesNotMatch(html, /Create your wallet first/u, "no dead-end copy");
});
