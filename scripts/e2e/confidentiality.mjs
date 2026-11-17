// Targeted-message confidentiality check shared by the e2e steps.
import { KnownBug } from "./report.mjs";

export function checkUninvitedTarget(evidence, received) {
  evidence.uninvitedTargetReceived = received;
  if (received)
    throw new KnownBug(
      "uninvited agent received a targeted message",
      "uninvited agent receives nothing",
    );
  return false;
}
