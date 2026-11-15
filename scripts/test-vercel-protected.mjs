import WebSocket from "ws";

const baseUrl = process.argv[2];
const oidcToken = process.env.VERCEL_OIDC_TOKEN;
if (!baseUrl || !oidcToken) {
  throw new Error("Provide a deployment URL and VERCEL_OIDC_TOKEN");
}
const trustedHeaders = { "x-vercel-trusted-oidc-idp-token": oidcToken };
const request = async (path, options = {}) => {
  const response = await fetch(new URL(path, baseUrl), {
    ...options,
    headers: { ...trustedHeaders, ...options.headers },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response;
};

const checkedRoutes = {};
for (const path of ["/health", "/", "/dashboard", "/demo", "/sdk/ai-auth.js"]) {
  const response = await request(path);
  checkedRoutes[path] = response.status;
}
const registration = await request("/v1/agents/register", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    name: "Protected Vercel E2E",
    runtime: "node-ws-check",
    category: "simulated_test_client",
  }),
});
const { agent, token } = await registration.json();
const ticketResponse = await request("/v1/events/ticket", {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ room: "vercel-e2e" }),
});
const { ticket } = await ticketResponse.json();
const socket = new WebSocket(
  new URL(
    `/v1/events?ticket=${encodeURIComponent(ticket)}`,
    baseUrl.replace(/^http/, "ws"),
  ),
  { headers: trustedHeaders, handshakeTimeout: 15_000 },
);
const connected = await new Promise((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error("WebSocket connection timed out")),
    20_000,
  );
  socket.once("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  socket.once("message", (data) => {
    clearTimeout(timer);
    try {
      resolve(JSON.parse(data.toString()));
    } catch (error) {
      reject(error);
    }
  });
});
socket.close();
if (connected.type !== "agent.connected" || connected.agentId !== agent.id) {
  throw new Error(`Unexpected WebSocket event: ${JSON.stringify(connected)}`);
}
console.log(
  JSON.stringify({
    deployment: baseUrl,
    protectedRoutes: checkedRoutes,
    registration: registration.status,
    ticket: ticketResponse.status,
    websocket: connected.type,
    category: connected.category,
    authenticated: true,
  }),
);
