/**
 * BODY4AI agent connect — complete integration module.
 *
 * Wire-up on the page:
 *   import { mountBody4AIAgentConnect } from "./agent-connect.js";
 *   mountBody4AIAgentConnect({ target: document.getElementById("body4ai-connect-panel") });
 *
 * Requires a hosted AI Auth wallet (see examples/body4ai/README.md, step 5).
 */
import {
  connectAIAuthModal,
  createAIAuthConnectInstruction,
  mountAIAuthCollaboration,
  mountAIAuthConnectPanel,
  mountAIAuthInPageAgent,
} from "@enzovezzaro/ai-auth-wallet";

const SITE_NAME = "BODY4AI";
const SITE_ORIGIN = "https://www.body4ai.com";
const WALLET_URL = "https://wallet.body4ai.com/wallet/";
const ROOM = "default";
const CAPABILITIES = ["presence.read", "messages.send", "tools.invoke"];

// Replace the bodies of these functions with the real catalog implementation.
// They run in the page, are read-only against the published catalog, and are
// only invoked after the wallet handshake and the human approval gate.
const CATALOG_ACTIONS = [
  {
    name: "search_products",
    description:
      "Search the BODY4AI published catalog by query, category, and price range.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search query" },
        category: { type: "string", description: "Optional category filter" },
      },
      required: ["query"],
    },
    requiredCapability: "tools.invoke",
    readOnly: true,
    execute: async ({ query, category }) => ({
      // return catalog search results here
      query,
      category: category ?? null,
      results: [],
    }),
  },
  {
    name: "get_product",
    description: "Open one BODY4AI product page by product id.",
    inputSchema: {
      type: "object",
      properties: { productId: { type: "string" } },
      required: ["productId"],
    },
    requiredCapability: "tools.invoke",
    readOnly: true,
    execute: async ({ productId }) => ({
      // return the product record here
      productId,
      url: `${SITE_ORIGIN}/products/${encodeURIComponent(productId)}`,
    }),
  },
  {
    name: "compare_products",
    description: "Compare two or more devices from the BODY4AI catalog.",
    inputSchema: {
      type: "object",
      properties: {
        productIds: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
        },
      },
      required: ["productIds"],
    },
    requiredCapability: "tools.invoke",
    readOnly: true,
    execute: async ({ productIds }) => ({
      // return the comparison table here
      productIds,
      comparison: [],
    }),
  },
  {
    name: "get_purchase_link",
    description:
      "Find review sources and the official purchase link for a product.",
    inputSchema: {
      type: "object",
      properties: { productId: { type: "string" } },
      required: ["productId"],
    },
    requiredCapability: "tools.invoke",
    readOnly: true,
    execute: async ({ productId }) => ({
      // return official/affiliate purchase links and review sources here
      productId,
      purchaseLink: null,
      reviewSources: [],
    }),
  },
];

export function mountBody4AIAgentConnect({ target, onStateChange } = {}) {
  const instruction = createAIAuthConnectInstruction({
    siteName: SITE_NAME,
    siteOrigin: SITE_ORIGIN,
    walletUrl: WALLET_URL,
    capabilities: CAPABILITIES,
    room: ROOM,
  });

  let connection = null;
  let inPageAgent = null;
  let removeCollaboration = null;

  async function setupAgent(session) {
    removeCollaboration = mountAIAuthCollaboration(session);
    inPageAgent = await mountAIAuthInPageAgent({
      connection: session,
      actions: CATALOG_ACTIONS,
      // Human approval gate: every requested action needs an explicit,
      // visible approval UI. Never auto-approve.
      authorize: async (action, input, context) =>
        window.confirm(
          `Allow the connected agent to run "${action.name}"?\n\n` +
            `Input: ${JSON.stringify(input, null, 2)}\n` +
            `Shared publicly: ${Boolean(context.sharedPublicly)}`,
        ),
      publishAction: (event) => session.publishAction(event),
    });
  }

  function teardownAgent() {
    inPageAgent?.close();
    inPageAgent = null;
    removeCollaboration?.();
    removeCollaboration = null;
  }

  const removePanel = mountAIAuthConnectPanel({
    target,
    instruction,
    onStateChange: (state) => {
      onStateChange?.(state);
      if (state.status === "connected") {
        if (!inPageAgent) void setupAgent(state.connection);
      } else if (state.status === "disconnected") {
        teardownAgent();
        connection = null;
      }
    },
    connect: async () => {
      // Called from the panel's Connect button (a user gesture).
      connection = await connectAIAuthModal({
        origin: SITE_ORIGIN,
        walletUrl: WALLET_URL,
        capabilities: CAPABILITIES,
        room: ROOM,
      });
      return connection;
    },
  });

  return function disconnect() {
    teardownAgent();
    connection?.close();
    connection = null;
    removePanel();
  };
}
