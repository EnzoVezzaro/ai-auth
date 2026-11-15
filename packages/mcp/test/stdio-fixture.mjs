import { connectAIAuthMcpStdio, createAIAuthMcpServer } from "../index.js";

const token = "stdio-fixture-session-012345678901234567890123456789";
const wallet = {
  id: "agent:stdio-fixture",
  publicKey: { kty: "EC", crv: "P-256", x: "x", y: "y" },
  async sign() {},
};
const { server } = await createAIAuthMcpServer({
  serviceClient: {
    async authenticate() {
      return {
        token,
        session: {
          id: "stdio-session",
          agentId: wallet.id,
          capabilities: ["messages.read"],
          expiresAt: Date.now() + 60_000,
        },
      };
    },
    async listMessages() {
      return { messages: [{ body: "stdio transport works" }] };
    },
  },
  wallet,
  requestedCapabilities: ["messages.read"],
  approveCapabilities: async (requested) => requested,
});

await connectAIAuthMcpStdio(server);
