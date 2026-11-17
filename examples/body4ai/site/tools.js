// BODY4AI WebMCP tools. catalog.search and product.get are read-only;
// wishlist.add is protected: it needs the tools.invoke scope, a live execution
// grant (authorizeProtected) AND an explicit human decision on this page.
import { getProduct, searchCatalog } from "./catalog.js";
import { ALLOW_LABEL, DENY_LABEL } from "./messages.js";

const TOOL_REQUESTS = Object.freeze({
  "catalog.search": "search the catalog",
  "product.get": "open a product",
  "wishlist.add": "add a product to your wishlist",
});

const objectSchema = (properties, required = []) => ({
  type: "object",
  properties,
  required,
});

export function buildActions({ wishlist, executions }) {
  const record = (name, input, context) =>
    executions.push({ name, input, requester: context.requester?.id ?? null });
  return [
    {
      name: "catalog.search",
      description: "Search the BODY4AI catalog (read-only).",
      inputSchema: objectSchema({
        query: { type: "string" },
        category: { type: "string" },
      }),
      requiredCapability: "tools.invoke",
      readOnly: true,
      async execute(input, context) {
        record("catalog.search", input, context);
        // Demo hook so the E2E can cancel a call that is genuinely running.
        if (input.query === "__wait_for_cancel__")
          await new Promise((resolve) =>
            context.signal.addEventListener("abort", resolve, { once: true }),
          );
        return { results: searchCatalog(input) };
      },
    },
    {
      name: "product.get",
      description: "Get one BODY4AI product by id (read-only).",
      inputSchema: objectSchema({ productId: { type: "string" } }, [
        "productId",
      ]),
      requiredCapability: "tools.invoke",
      readOnly: true,
      async execute(input, context) {
        record("product.get", input, context);
        return { product: getProduct(input.productId) };
      },
    },
    {
      name: "wishlist.add",
      description: "Add a product to the visitor's wishlist (needs approval).",
      // Always requires the participation policy gate for remote requesters.
      protected: true,
      inputSchema: objectSchema({ productId: { type: "string" } }, [
        "productId",
      ]),
      requiredCapability: "tools.invoke",
      async execute(input, context) {
        record("wishlist.add", input, context);
        if (!getProduct(input.productId)) throw new Error("Unknown product");
        wishlist.push({ productId: input.productId, by: context.requester.id });
        return { ok: true, wishlist: wishlist.map((item) => item.productId) };
      },
    },
  ];
}

/** Human approval panel: resolves true/false from the visitor's click. */
export function askHuman({ target, action }) {
  const panel = document.createElement("div");
  panel.dataset.approval = action.name;
  panel.setAttribute("role", "alertdialog");
  const text = document.createElement("p");
  const request = TOOL_REQUESTS[action.name] ?? "use a page tool";
  text.textContent = `A connected agent wants to ${request}. Allow it?`;
  const approve = document.createElement("button");
  approve.id = "approve-action";
  approve.textContent = ALLOW_LABEL;
  const deny = document.createElement("button");
  deny.id = "deny-action";
  deny.className = "secondary";
  deny.textContent = DENY_LABEL;
  panel.append(text, approve, deny);
  target.append(panel);
  return new Promise((resolve) => {
    const done = (value) => {
      panel.remove();
      resolve(value);
    };
    approve.addEventListener("click", () => done(true));
    deny.addEventListener("click", () => done(false));
  });
}

/**
 * The human gate. The SDK already enforced membership scope and the execution
 * grant before this runs; read-only tools need no extra click, side effects do.
 */
export function makeAuthorize({ target, log }) {
  return async (action, input, context) => {
    const requester = context.requester?.id;
    if (!requester) {
      log("denied", action.name, "no verified requester");
      return false;
    }
    if (action.readOnly) return true;
    const approved = await askHuman({ target, action });
    if (!approved) log("denied", action.name, "human declined");
    return approved;
  };
}
