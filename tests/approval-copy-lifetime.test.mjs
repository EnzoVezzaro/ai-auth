import assert from "node:assert/strict";
import test from "node:test";
import {
  appSource,
  extractFunction,
  runFragment,
} from "./helpers/app-source.mjs";

const source = await appSource();

function approvalCopy() {
  // A Never grant has no end: the approval view must not promise a short
  // lifetime. Run the real connectView against that state.
  const sandbox = runFragment(extractFunction(source, "connectView"), {
    console,
    state: {
      externalRequest: null,
      wallet: { id: "agent:test", name: "Test" },
      consent: { body: { payload: { expiresAt: null } } },
      request: { audience: "https://site.example" },
    },
    location: { origin: "https://site.example" },
    capabilityOptions: [],
    pageHead: (eyebrow, title, description) =>
      `<header>${eyebrow} ${title} ${description}</header>`,
    walletRequired: () => "",
    setupFormError: () => "",
    esc: (value) => String(value),
  });
  return sandbox.connectView();
}

test("approval copy does not claim a lifetime the grant may not have", () => {
  const html = approvalCopy();
  assert.doesNotMatch(
    html,
    /expires quickly/u,
    "a Never grant does not expire quickly",
  );
  assert.doesNotMatch(
    html,
    /the time limit and the permissions/u,
    "a Never grant has no fixed time limit to confirm",
  );
  assert.match(
    html,
    /lasts only as long as you choose/u,
    "the copy explains that the person chooses the lifetime",
  );
});
