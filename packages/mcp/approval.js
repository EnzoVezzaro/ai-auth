import { createInterface } from "node:readline";

export class ApprovalError extends Error {
  constructor(message) {
    super(message);
    this.name = "ApprovalError";
  }
}

const MEANING = {
  "presence.read": "join the room, appear as a peer, and read room events",
  "messages.send": "send signed text messages to peers in the room",
  "tools.invoke":
    "list and call the site's WebMCP tools (the site owner still approves each call)",
};

export function renderPreview({ origin, room, walletId, requested, source }) {
  const lines = [
    "AI Auth agent connection preview",
    `  Site origin : ${origin}`,
    `  Room        : ${room ?? "(not chosen yet)"}`,
    `  Agent wallet: ${walletId}`,
    `  Requested by: ${source === "url" ? "URL discovery (no scopes; nothing is granted by a URL)" : source}`,
    "  Scopes you can grant (a signature proves key possession, not who you are):",
    ...requested.map(
      (cap) => `    - ${cap}: ${MEANING[cap] ?? "site-defined operation"}`,
    ),
    "  Data goes directly to peers over WebRTC; public Nostr relays see only signaling.",
  ];
  return lines.join("\n");
}

function validateScopes(list, requested) {
  if (!Array.isArray(list) || list.length === 0)
    throw new ApprovalError("No capabilities were approved; connection denied");
  if (new Set(list).size !== list.length)
    throw new ApprovalError("Approved capabilities contain duplicates");
  for (const cap of list) {
    if (cap === "*" || cap === "all")
      throw new ApprovalError(
        "Wildcard approvals are not allowed; list exact scopes",
      );
    if (!requested.includes(cap))
      throw new ApprovalError(
        `"${cap}" was not requested by the site; approvals can never escalate`,
      );
  }
  return [...list].sort();
}

/**
 * Decide the granted scopes. Always a subset of `requested`. Without a TTY the
 * caller must pass exact scopes via --approve; there is no implicit approval.
 */
export async function resolveApproval({
  requested,
  approve,
  interactive,
  ask,
}) {
  if (approve !== null && approve !== undefined)
    return validateScopes(approve, requested);
  if (!interactive)
    throw new ApprovalError(
      "Refusing to auto-approve without a TTY: pass --approve with the exact scopes to grant",
    );
  const answer = String((await ask(requested)) ?? "").trim();
  if (!answer)
    throw new ApprovalError("No capabilities were approved; connection denied");
  if (answer === "all") return [...requested].sort();
  return validateScopes(
    answer
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    requested,
  );
}

/** Visible line prompt on the controlling TTY (stderr keeps stdout clean). */
export function askOnTty({
  input = process.stdin,
  output = process.stderr,
} = {}) {
  return (requested) =>
    new Promise((resolve) => {
      const rl = createInterface({ input, output });
      rl.question(
        `Grant which scopes? (comma list of ${requested.join(", ")}; "all"; empty = deny): `,
        (line) => {
          rl.close();
          resolve(line);
        },
      );
    });
}
