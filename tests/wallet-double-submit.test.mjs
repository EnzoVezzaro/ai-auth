import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import "fake-indexeddb/auto";
import {
  createWallet,
  downloadBackup,
  importWalletBackup,
} from "../packages/p2p/index.js";
import { createStubDom } from "./dom-stub.mjs";
import {
  appSource,
  extractFunction,
  runFragment,
} from "./helpers/app-source.mjs";

globalThis.crypto ??= webcrypto;

const source = await appSource();
const PASSPHRASE = "correct horse battery staple";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function submitTwice(form) {
  const handler = [...form._listeners.get("submit")][0];
  const event = () => ({ preventDefault() {}, currentTarget: form });
  // Two rapid submits overlap: neither has settled before the next begins.
  return Promise.all([handler(event()), handler(event())]);
}

function setup() {
  const { doc } = createStubDom();
  doc.body.innerHTML = `
    <form id="create-wallet-form">
      <input id="wallet-name" name="name"/>
      <input id="wallet-passphrase" name="passphrase" type="password"/>
      <input id="wallet-passphrase-confirm" name="confirmation" type="password"/>
      <button type="submit">Create wallet and backup</button>
    </form>
    <form id="import-wallet-form">
      <input id="backup-file" type="file"/>
      <input id="restore-passphrase" type="password"/>
      <button type="submit">Unlock and restore</button>
    </form>`;
  doc.querySelector = (selector) => doc.body.querySelector(selector);
  doc.querySelectorAll = (selector) => doc.body.querySelectorAll(selector);

  const creates = [];
  const imports = [];
  const downloads = [];
  const errors = [];
  const state = {
    error: "",
    wallet: null,
    view: "wallet",
    externalRequest: null,
  };
  const sandbox = runFragment(extractFunction(source, "bindView"), {
    document: doc,
    $: (selector) => doc.querySelector(selector),
    FormData: class {
      get(name) {
        return {
          name: "Test agent",
          passphrase: PASSPHRASE,
          confirmation: PASSPHRASE,
        }[name] ?? null;
      }
    },
    createWallet: async (...args) => {
      creates.push(args);
      await sleep(25);
      return createWallet(...args);
    },
    importWalletBackup: async (...args) => {
      imports.push(args);
      await sleep(25);
      return importWalletBackup(...args);
    },
    downloadBackup,
    downloadJson: (filename, text) => downloads.push({ filename, text }),
    appendActivity: async () => {},
    startRoom: async () => {},
    render: () => {},
    toast: () => {},
    fail: (error) => errors.push(error),
    sleep,
    rootViewButtons: () => {},
    externalConnectMode: false,
    state,
  });
  sandbox.bindView();
  return { doc, state, creates, imports, downloads, errors, sandbox };
}

test("WA-01 two rapid create submits create exactly one key and one recovery file", async () => {
  const { doc, state, creates, downloads, errors } = setup();
  const form = doc.querySelector("#create-wallet-form");

  await submitTwice(form);

  assert.equal(creates.length, 1, "the create handler must run once");
  assert.equal(downloads.length, 1, "only one recovery file may be downloaded");
  assert.equal(errors.length, 0, "no handler failed");
  assert.ok(state.wallet, "the wallet is created");
});

test("WA-01 two rapid restore submits import exactly one wallet", async () => {
  const wallet = await createWallet({
    name: "Original",
    passphrase: PASSPHRASE,
  });
  const backup = downloadBackup(wallet);
  const { doc, state, imports, errors } = setup();
  const form = doc.querySelector("#import-wallet-form");
  doc.querySelector("#backup-file").files = [{ text: async () => backup }];
  doc.querySelector("#restore-passphrase").value = PASSPHRASE;

  await submitTwice(form);

  assert.equal(imports.length, 1, "the restore handler must run once");
  assert.equal(errors.length, 0, "no handler failed");
  assert.ok(state.wallet, "the wallet is restored");
});
