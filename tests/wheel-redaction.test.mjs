import assert from "node:assert/strict";
import test from "node:test";
import {
  describeElementForShare,
  extractSafeText,
  isSensitiveElement,
} from "../packages/p2p/wheel-redaction.js";

// Minimal DOM doubles: only what the redaction walk reads.
function el(tag, attrs = {}, children = []) {
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    parentElement: null,
    childNodes: children,
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    hasAttribute: (name) => name in attrs,
  };
  for (const child of children)
    if (child.nodeType === 1) child.parentElement = node;
  return node;
}
const text = (value) => ({ nodeType: 3, nodeValue: value });
const location = { origin: "https://example.test", pathname: "/page" };

test("password, credential autocomplete, contenteditable and private markers are sensitive", () => {
  assert.equal(isSensitiveElement(el("input", { type: "password" })), true);
  assert.equal(isSensitiveElement(el("input", { type: "PASSWORD" })), true);
  for (const token of [
    "current-password",
    "new-password",
    "one-time-code",
    "username",
    "cc-number",
    "section-a cc-csc",
  ])
    assert.equal(
      isSensitiveElement(el("input", { autocomplete: token })),
      true,
      token,
    );
  for (const value of ["", "true", "plaintext-only"])
    assert.equal(
      isSensitiveElement(el("div", { contenteditable: value })),
      true,
      value,
    );
  assert.equal(isSensitiveElement(el("div", { "data-private": "" })), true);
  assert.equal(
    isSensitiveElement(el("div", { "data-ai-auth-private": "true" })),
    true,
  );
});

test("ordinary elements are not sensitive", () => {
  assert.equal(isSensitiveElement(el("p", {}, [text("hello")])), false);
  assert.equal(
    isSensitiveElement(el("input", { type: "text", autocomplete: "off" })),
    false,
  );
  assert.equal(
    isSensitiveElement(el("div", { contenteditable: "false" })),
    false,
  );
});

test("anything inside a private region is sensitive", () => {
  const inner = el("span", {}, [text("secret")]);
  el("div", { "data-ai-auth-private": "" }, [inner]);
  assert.equal(isSensitiveElement(inner), true);
  const editable = el("p");
  el("section", { contenteditable: "true" }, [editable]);
  assert.equal(isSensitiveElement(editable), true);
});

test("safe text omits private descendants and every form control value", () => {
  const root = el("div", {}, [
    text("Account "),
    el("span", { "data-private": "" }, [text("4111 1111")]),
    el("input", { type: "text" }),
    el("textarea", {}, [text("draft notes")]),
    el("script", {}, [text("alert(1)")]),
    el("b", {}, [text("settings")]),
  ]);
  const result = extractSafeText(root);
  assert.equal(result.text, "Account settings");
  assert.equal(result.omitted, 3);
});

test("safe text is length-bounded and empty for a sensitive root", () => {
  assert.equal(
    extractSafeText(el("p", {}, [text("x".repeat(5000))]), { max: 50 }).text
      .length,
    50,
  );
  const secret = el("div", { "data-private": "" }, [text("secret")]);
  assert.deepEqual(extractSafeText(secret), { text: "", omitted: 1 });
});

test("describeElementForShare blocks sensitive elements and never includes values", () => {
  assert.deepEqual(
    describeElementForShare(
      el("input", { type: "password", value: "hunter2" }),
      location,
    ),
    { blocked: true },
  );
  const ok = describeElementForShare(
    el("input", { type: "text", value: "typed", "aria-label": "Search" }),
    location,
  );
  assert.equal(ok.blocked, false);
  assert.deepEqual(ok.metadata, {
    tag: "input",
    text: "Search",
    url: "https://example.test/page",
  });
  const blockedLabel = describeElementForShare(
    el("div", { "aria-label": "private", "data-private": "" }),
    location,
  );
  assert.equal(blockedLabel.blocked, true);
});
