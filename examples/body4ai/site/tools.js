// BODY4AI WebMCP tools. catalog.search and product.get are read-only;
// wishlist.add is protected: it needs the tools.invoke scope, a live execution
// grant (authorizeProtected) AND an explicit human decision on this page.
import { authorizeProtected } from "../../../packages/p2p/browser.js";
import { getProduct, searchCatalog } from "./catalog.js";

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
export function askHuman({ target, action, input, requester }) {
  const panel = document.createElement("div");
  panel.dataset.approval = action.name;
  panel.setAttribute("role", "alertdialog");
  const text = document.createElement("p");
  text.textContent = `Agent ${requester.slice(6, 18)} wants to run ${action.name} ${JSON.stringify(input)}`;
  const approve = document.createElement("button");
  approve.id = "approve-action";
  approve.textContent = "Approve";
  const deny = document.createElement("button");
  deny.id = "deny-action";
  deny.textContent = "Deny";
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

export function makeAuthorize({ policy, target, log }) {
  return async (action, input, context) => {
    const requester = context.requester?.id;
    if (!requester || !policy.can(requester, "tools.invoke")) {
      log("denied", action.name, "missing scope");
      return false;
    }
    if (action.readOnly) return true;
    const verdict = authorizeProtected({
      policy,
      walletId: requester,
      scope: "tools.invoke",
    });
    if (!verdict.allow) {
      log("denied", action.name, verdict.reason);
      return false;
    }
    return askHuman({ target, action, input, requester });
  };
}
