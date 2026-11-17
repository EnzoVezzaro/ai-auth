// Default privacy rules for content the wheel shares from the page.
// The walk uses only attribute and node-tree access (no CSS selector engine) so
// it behaves the same on real DOM nodes and on plain test doubles.

/** CSS selector matching the same regions, for counting/warning on a document. */
export const SENSITIVE_SELECTOR = [
  'input[type="password" i]',
  "input[autocomplete]",
  "[contenteditable]:not([contenteditable='false' i])",
  "[data-private]",
  "[data-ai-auth-private]",
].join(",");

const CREDENTIAL_TOKENS = new Set([
  "username",
  "current-password",
  "new-password",
  "one-time-code",
  "webauthn",
  "cc-name",
  "cc-number",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
  "cc-csc",
  "cc-type",
]);
const FORM_CONTROLS = new Set(["INPUT", "TEXTAREA", "SELECT", "OPTION"]);
const SKIPPED = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"]);
const EDITABLE = new Set(["", "true", "plaintext-only"]);

const attr = (el, name) => el?.getAttribute?.(name) ?? null;
const present = (el, name) =>
  typeof el?.hasAttribute === "function"
    ? el.hasAttribute(name)
    : attr(el, name) !== null;

/** Sensitive because of the element itself (not its ancestors). */
export function isSensitiveSelf(el) {
  if (!el || typeof el !== "object") return false;
  const tag = String(el.tagName ?? "").toUpperCase();
  if (
    tag === "INPUT" &&
    String(attr(el, "type") ?? el.type ?? "").toLowerCase() === "password"
  )
    return true;
  const tokens = String(attr(el, "autocomplete") ?? "")
    .toLowerCase()
    .split(/\s+/u);
  if (tokens.some((token) => CREDENTIAL_TOKENS.has(token))) return true;
  const editable = attr(el, "contenteditable");
  if (editable !== null && EDITABLE.has(editable.toLowerCase())) return true;
  if (el.isContentEditable === true) return true;
  return present(el, "data-private") || present(el, "data-ai-auth-private");
}

/** Sensitive itself or inside any sensitive ancestor region. */
export function isSensitiveElement(el) {
  for (let node = el, depth = 0; node && depth < 200; depth++) {
    if (isSensitiveSelf(node)) return true;
    node = node.parentElement ?? null;
  }
  return false;
}

/**
 * Visible text of `el` with every sensitive region, form control value, and
 * non-rendered node omitted. Returns text plus how many regions were omitted.
 */
export function extractSafeText(el, { max = 1000 } = {}) {
  const parts = [];
  let omitted = 0;
  let length = 0;
  const walk = (node, depth) => {
    if (length > max || depth > 100) return;
    if (node.nodeType === 3) {
      const text = String(node.nodeValue ?? "");
      parts.push(text);
      length += text.length;
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = String(node.tagName ?? "").toUpperCase();
    if (SKIPPED.has(tag)) return;
    if (isSensitiveSelf(node) || FORM_CONTROLS.has(tag)) {
      omitted += 1;
      return;
    }
    for (const child of node.childNodes ?? []) walk(child, depth + 1);
  };
  if (!el || isSensitiveElement(el)) return { text: "", omitted: 1 };
  walk(el, 0);
  const text = parts.join("").replace(/\s+/gu, " ").trim().slice(0, max);
  return { text, omitted };
}

/**
 * Number of sensitive regions on a live document (for capture warnings).
 * Uses the same predicate as the element walk so the warning matches what the
 * redaction policy actually withholds; a region is counted once, not once per
 * nested field.
 */
export function countSensitiveRegions(doc) {
  const root = doc?.documentElement ?? doc?.body;
  let count = 0;
  const walk = (node, depth) => {
    if (!node || depth > 200) return;
    if (node.nodeType !== 1) return;
    if (isSensitiveSelf(node)) {
      count += 1;
      return;
    }
    for (const child of node.childNodes ?? []) walk(child, depth + 1);
  };
  walk(root, 0);
  return count;
}

/** Build the element metadata that will be previewed and sent. */
export function describeElementForShare(el, location) {
  if (isSensitiveElement(el)) return { blocked: true };
  const { text, omitted } = extractSafeText(el);
  const aria = attr(el, "aria-label");
  const label =
    text || (aria && !isSensitiveSelf(el) ? aria.slice(0, 200) : "");
  return {
    blocked: false,
    omitted,
    metadata: {
      tag: String(el.tagName ?? "element").toLowerCase(),
      text: label,
      url: `${location.origin}${location.pathname}`,
    },
  };
}
