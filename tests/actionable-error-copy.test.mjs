import assert from "node:assert/strict";
import test from "node:test";
import {
  CANCELLED_MESSAGE,
  RELOAD_NOTICE,
  RESUME_TIMEOUT_MESSAGE,
  WALLET_REQUIRED_MESSAGE,
  approvalTimeoutMessage,
  sessionEndText,
} from "../packages/p2p/copy.js";
import { appSource } from "./helpers/app-source.mjs";

const source = await appSource();
// A message is actionable when it names a control or a concrete next step.
const NEXT_STEP =
  /(?:click|choose|enter|select|return to|refresh|reload|try again|start a new|wait|check|decline|unlock|reconnect|save|create your wallet|connect agent|connect again)/iu;

function appErrorMessages(src) {
  const messages = [];
  for (const match of src.matchAll(/new Error\(\s*["`]([^"`]+)["`]/gu))
    messages.push(match[1]);
  for (const match of src.matchAll(/state\.error =\s*\n?\s*["`]([^"`]+)["`]/gu))
    messages.push(match[1]);
  for (const match of src.matchAll(/toast\(\s*\n?\s*`([^`]*)`/gu)) {
    if (/failed|could not|error/iu.test(match[1])) messages.push(match[1]);
  }
  return messages;
}

test("every wallet error names a next step", () => {
  const deadEnds = appErrorMessages(source).filter(
    (message) => !NEXT_STEP.test(message),
  );
  assert.deepEqual(
    deadEnds,
    [],
    "errors and warning toasts in app.js must tell the person what to do next",
  );
});

test("session-time failures in copy.js name a next step", () => {
  const messages = [
    sessionEndText(Date.now() - 1),
    sessionEndText(Number.NaN),
    WALLET_REQUIRED_MESSAGE,
    CANCELLED_MESSAGE,
    RELOAD_NOTICE,
    RESUME_TIMEOUT_MESSAGE,
    approvalTimeoutMessage(120_000),
  ];
  for (const message of messages)
    assert.match(message, NEXT_STEP, `dead-end copy: ${message}`);
});
