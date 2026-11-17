import {
  AGENT_DESCRIPTOR_TYPE,
  AGENT_DESCRIPTOR_VERSION,
  AGENT_PROTOCOL_VERSION,
  CHALLENGE_MAX_MS,
  COLLABORATION_LIMITS,
  CONNECTION_STATUSES,
  CONNECTION_TRANSITIONS,
  CONSENT_VERSION,
  CollaborationTransfers,
  DEFAULT_DESCRIPTOR_TTL_MS,
  DEFAULT_EXECUTION_GRANT_TTL_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_SESSION_TTL_MS,
  DURATION_KINDS,
  DURATION_LIMITS,
  EXECUTION_GRANT_TYPE,
  INSTANCE_BINDING_TYPE,
  LINK_POLICY,
  MAX_DESCRIPTOR_TTL_MS,
  MAX_EVENT_AGE_MS,
  MAX_EXECUTION_GRANT_TTL_MS,
  MAX_MEMBERSHIP_TTL_MS,
  MAX_SEEN_EVENTS,
  MAX_SESSION_TTL_MS,
  MEMBERSHIP_TYPE,
  MEMBERSHIP_VERSION,
  MESSAGE_STATES,
  MIN_SESSION_TTL_MS,
  ManualWebRTC,
  NonceGuard,
  NostrWebRTC,
  OPEN_ROOM_DISCLOSURE,
  P2PRoom,
  RECEIPT_TYPE,
  RECEIPT_VERSION,
  REVOCATION_GOSSIP_EVENT,
  REVOCATION_KINDS,
  REVOCATION_TYPE,
  REVOCATION_VERSION,
  ROLES,
  ROOM_MODES,
  SENSITIVE_SELECTOR,
  SessionLease,
  appendActivity,
  approveLink,
  approvePermissionRequest,
  authorizeProtected,
  bindInstance,
  buildReceiptPayload,
  canTransition,
  canonicalize,
  connectAIAuthModal,
  connectAIAuthPopup,
  createAIAuthAgentClient,
  createAIAuthConnectController,
  createAIAuthConnectInstruction,
  createAgentDescriptor,
  createCapabilityGrant,
  createCloneDetector,
  createConnectionState,
  createDeliveryLedger,
  createInstanceId,
  createLinkChallenge,
  createLinkNonceStore,
  createParticipationPolicy,
  createPermissionRequest,
  createRevocation,
  createRevocationGossip,
  createRevokedLinkSet,
  createSessionStore,
  createSharedRoomTopic,
  createWallet,
  deriveLinkId,
  downloadBackup,
  extractSafeText,
  forgetWallet,
  identityFor,
  importWalletBackup,
  isAddressedTo,
  isSensitiveElement,
  issueExecutionGrant,
  issueMembership,
  listLinks,
  loadWallet,
  mountAIAuthCollaboration,
  mountAIAuthConnectPanel,
  mountAIAuthInPageAgent,
  mountCollaborationWheel,
  randomNonce,
  readActivity,
  recordFromConsent,
  registerAIAuthPageActions,
  renewExecutionGrant,
  resolveDuration,
  resumeAIAuthSession,
  sessionLimits,
  signEnvelope,
  unlink,
  verifyAgentDescriptor,
  verifyCapabilityGrant,
  verifyEnvelope,
  verifyExecutionGrant,
  verifyInstanceBinding,
  verifyLink,
  verifyLinkRevocation,
  verifyMembership,
  verifyPermissionConsent,
  verifyPermissionRequest,
  verifyPopupPermissionRequest,
  verifyReceipt,
  verifyRevocation,
} from "@enzovezzaro/ai-auth-wallet";
import type {
  AIAuthAgentToolCatalog,
  AIAuthConnectInstruction,
  AIAuthPageAction,
  AIAuthPageConnection,
  AIAuthSessionRecord,
  CapabilityGrant,
  ConnectionSnapshot,
  DeliveryLedger,
  LinkChallenge,
  LinkProof,
  MembershipProof,
  ParticipationPolicy,
  PermissionRequest,
  RevocationRecord,
  SignedEnvelope,
  WalletIdentity,
} from "@enzovezzaro/ai-auth-wallet";

// Type-checked only (npm run test:types). Never executed.
export async function exerciseWallet(origin: string): Promise<void> {
  const passphrase = "a long passphrase for the fixture";
  const wallet: WalletIdentity = await createWallet({
    name: "Research agent",
    passphrase,
  });
  const stored: WalletIdentity | null = await loadWallet();
  const restored: WalletIdentity = await importWalletBackup(
    downloadBackup(wallet),
    passphrase,
  );
  const walletId: string = await identityFor(restored.publicKey);
  const nonce: string = randomNonce();
  const note: SignedEnvelope<{ text: string }> = await signEnvelope(
    wallet,
    "demo/note",
    { text: canonicalize({ nonce }) },
  );
  const valid: boolean = await verifyEnvelope(note, {
    expectedIssuer: walletId,
    maxAgeMs: MAX_EVENT_AGE_MS,
  });
  const activity: SignedEnvelope[] = await readActivity();
  await appendActivity(wallet, "demo/activity", { count: activity.length });
  const guard = new NonceGuard();
  const accepted: boolean = guard.consume(nonce, Date.now() + MAX_SEEN_EVENTS);
  void valid;
  void accepted;
  void stored;
  void MAX_EVENT_AGE_MS;
  await forgetWallet();
}

export async function exercisePermissions(
  origin: string,
  wallet: WalletIdentity,
): Promise<void> {
  const request: PermissionRequest = await createPermissionRequest(
    origin,
    ["presence.read", "tools.invoke"],
    { expiresInMs: 60_000, room: "research" },
  );
  const consent = await approvePermissionRequest(wallet, request, [
    "presence.read",
  ]);
  const verified: boolean = await verifyPermissionConsent(consent, request, {
    expectedOrigin: origin,
    expectedWallet: wallet.id,
  });
  const requestOk: boolean = await verifyPermissionRequest(request, {
    expectedOrigin: origin,
  });
  const grant: CapabilityGrant = await createCapabilityGrant(wallet, {
    recipient: wallet.id,
    resource: origin,
    capabilities: ["presence.read"],
    expiresAt: Date.now() + 60_000,
  });
  const granted: boolean = await verifyCapabilityGrant(grant, {
    expectedIssuer: wallet.id,
    expectedRecipient: wallet.id,
    resource: origin,
    requiredCapability: "presence.read",
  });
  void verified;
  void requestOk;
  void granted;
  void createSharedRoomTopic;
  void verifyPopupPermissionRequest;
}

export async function exerciseRoom(
  origin: string,
  wallet: WalletIdentity,
  policy: ParticipationPolicy,
  membership: MembershipProof,
): Promise<void> {
  const room = new P2PRoom(wallet, "research", {
    origin,
    capabilities: null,
    participation: { policy, membership },
  });
  const unsubscribe: () => void = room.subscribe((event) => {
    if (event.envelope) void event.envelope.body.type;
  });
  await room.start();
  const sent: SignedEnvelope = await room.send("message/text", {
    text: "hello",
  });
  const topic: string = await createSharedRoomTopic(origin, "research");
  const network = new NostrWebRTC(room, {
    origin,
    room: "research",
    relayUrls: ["wss://relay.example"],
  });
  await network.start();
  const snapshot: ConnectionSnapshot = network.connectionState;
  const stopState: () => void = network.onConnectionState((next) => {
    void next.status;
  });
  const manual = new ManualWebRTC(room);
  void manual.offer;
  unsubscribe();
  stopState();
  void sent;
  void topic;
  void snapshot;
  await network.close();
  await room.close();
}

export async function exerciseConnection(origin: string): Promise<void> {
  const connection: AIAuthPageConnection = await connectAIAuthModal({
    walletUrl: "https://wallet.example/",
    capabilities: ["presence.read", "tools.invoke"],
    room: "research",
    origin,
    timeoutMs: 1_000,
  });
  const legacy: AIAuthPageConnection = await connectAIAuthPopup({
    walletUrl: "https://wallet.example/",
    capabilities: ["presence.read"],
  });
  const action: AIAuthPageAction = {
    name: "site.count",
    description: "Count public records.",
    inputSchema: { type: "object", properties: {} },
    requiredCapability: "tools.invoke",
    readOnly: true,
    execute: async (_input, context) => ({ requestId: context.requestId }),
  };
  const api = await registerAIAuthPageActions({
    connection,
    actions: [action],
    authorize: async (_action, _input, _context) => true,
  });
  const agent = await mountAIAuthInPageAgent({
    connection,
    actions: [action],
    authorize: () => true,
  });
  const result: unknown = await agent.execute("site.count", {});
  void result;
  void api.tools;
  agent.stop();
  api.close();
  const client = createAIAuthAgentClient(
    {} as unknown as Parameters<typeof createAIAuthAgentClient>[0],
  );
  const catalog: AIAuthAgentToolCatalog | undefined = client.catalogs[0];
  if (catalog) await client.callTool(catalog, "site.count", { q: "x" });
  client.close();
  mountAIAuthCollaboration(connection);
  mountCollaborationWheel(connection.transfers, { capabilities: ["messages.send"] });
  connection.close("closed");
  void legacy;
}

export function exerciseConnectUi(origin: string): void {
  const instruction: AIAuthConnectInstruction = createAIAuthConnectInstruction({
    siteOrigin: origin,
    walletUrl: "https://wallet.example/",
    capabilities: ["presence.read"],
  });
  const controller = createAIAuthConnectController({
    instruction: instruction.instruction,
  });
  const state = controller.getState();
  void state.status;
  const target = document.createElement("div");
  const unmount = mountAIAuthConnectPanel({ instruction, target });
  unmount();
  controller.close();
}

export async function exerciseLinksAndMembership(
  origin: string,
  wallet: WalletIdentity,
): Promise<void> {
  const nonceStore = createLinkNonceStore();
  const challenge: LinkChallenge = createLinkChallenge({
    origin,
    resource: "research",
    capabilities: ["presence.read"],
    nonceStore,
  });
  const proof: LinkProof = await approveLink(wallet, challenge, {
    capabilities: ["presence.read"],
  });
  const link = await verifyLink(proof, {
    expectedOrigin: origin,
    expectedResource: "research",
    expectedCapabilities: ["presence.read"],
    nonceStore,
  });
  const linkId: string = await deriveLinkId({
    origin,
    walletId: wallet.id,
    resource: "research",
    nonce: challenge.nonce,
  });
  const links = await listLinks(wallet);
  const revocation = await unlink(wallet, linkId);
  const revoked = await verifyLinkRevocation(revocation, {
    expectedOrigin: origin,
  });
  void link;
  void links;
  void revoked;
  void LINK_POLICY.maxLinkSeconds;
  void createRevokedLinkSet().has(linkId);

  const trustPolicy = { issuers: [wallet.publicKey] };
  const membership: MembershipProof = await issueMembership(wallet, {
    subject: wallet.id,
    origin,
    room: "research",
    role: "member",
    scopes: ["messages.send"],
    duration: { kind: "short" },
  });
  const verified = await verifyMembership(membership, {
    trustPolicy,
    expectedOrigin: origin,
    expectedRoom: "research",
    expectedSubject: wallet.id,
  });
  const policy: ParticipationPolicy = createParticipationPolicy({
    mode: "restricted",
    trustPolicy,
    origin,
    room: "research",
  });
  const allowed = authorizeProtected({
    policy,
    walletId: wallet.id,
    scope: "messages.send",
  });
  const grant = await issueExecutionGrant(wallet, {
    subject: wallet.id,
    origin,
    room: "research",
    membershipId: membership.id,
    ttlMs: resolveDuration({ kind: "long", ttlMs: 60_000 }).ttlMs,
  });
  const renewed = await renewExecutionGrant(wallet, grant);
  const grantCheck = await verifyExecutionGrant(renewed, {
    trustPolicy,
    expectedOrigin: origin,
    expectedRoom: "research",
    expectedSubject: wallet.id,
  });
  void verified;
  void allowed;
  void grantCheck;
  void DURATION_LIMITS.short;
  void OPEN_ROOM_DISCLOSURE;

  const record: Readonly<RevocationRecord> = await createRevocation(wallet, {
    kind: "membership",
    target: membership.id,
    origin,
    room: "research",
  });
  const accepted = await verifyRevocation(record, {
    trustPolicy,
    expectedOrigin: origin,
    expectedRoom: "research",
  });
  const gossip = createRevocationGossip(
    {
      send: async () => undefined,
      subscribe: () => () => {},
    },
    { policy },
  );
  const published = await gossip.publish(record);
  gossip.close();
  void accepted;
  void published;
}

export async function exerciseAgentAndReceipts(
  origin: string,
  wallet: WalletIdentity,
  ledger: DeliveryLedger,
): Promise<void> {
  const instanceId = createInstanceId();
  const binding = await bindInstance(wallet, instanceId);
  const bound = await verifyInstanceBinding(binding);
  const descriptor = await createAgentDescriptor(wallet, {
    instanceId,
    agentType: "assistant",
    runtime: { name: "node", version: "22" },
    sessionId: "session-123456",
    origin,
    room: "research",
    nonce: randomNonce(),
    ttlMs: DEFAULT_DESCRIPTOR_TTL_MS,
  });
  const verified = await verifyAgentDescriptor(descriptor, {
    expectedOrigin: origin,
    expectedRoom: "research",
    expectedNonce: descriptor.nonce,
  });
  const detector = createCloneDetector();
  detector.observe({
    walletId: wallet.id,
    instanceId,
    sessionId: "session-123456",
    expiresAt: Date.now() + 60_000,
  });
  void bound;
  void verified;
  void AGENT_PROTOCOL_VERSION;

  const receipt = buildReceiptPayload({
    messageId: "message-0001",
    sender: wallet.id,
    receiver: wallet.id,
  });
  const verifiedReceipt = await verifyReceipt(receipt, {
    sender: wallet.id,
    room: "research",
    origin,
  });
  ledger.begin({ messageId: receipt.messageId, kind: "text" });
  const addressed: boolean = isAddressedTo({ target: wallet.id }, wallet.id);
  const state = createConnectionState();
  state.transition("signaling");
  const legal: boolean = canTransition("idle", "signaling");
  void verifiedReceipt;
  void addressed;
  void legal;
  void MESSAGE_STATES;
  void RECEIPT_TYPE;
  void extractSafeText;
  void isSensitiveElement;
  void SENSITIVE_SELECTOR;
}

export async function exerciseSessionResume(
  walletUrl: string,
  capabilities: string[],
): Promise<void> {
  const store = createSessionStore({ storage: sessionStorage });
  const record: AIAuthSessionRecord = recordFromConsent(undefined, {
    origin: "https://site.example",
    room: "research",
    participant: { instanceId: "instance-1", sessionId: "session-1" },
    now: () => Date.now(),
  });
  void record;
  // origin is optional; resumeAIAuthSession defaults it from location.
  const connection = await resumeAIAuthSession({
    walletUrl,
    capabilities,
    storage: sessionStorage,
    sessionStore: store,
    resumeTimeoutMs: 1_000,
    now: Date.now(),
  });
  connection?.close("closed");
  await connectAIAuthModal({
    walletUrl,
    capabilities,
    storage: sessionStorage,
    sessionStore: store,
    resumeTimeoutMs: 1_000,
  }).catch(() => undefined);
}

export const fixtureVersion = {
  limits: COLLABORATION_LIMITS.textCharacters,
  session: sessionLimits({ sessionTtlMs: DEFAULT_SESSION_TTL_MS }),
  constants: [
    CHALLENGE_MAX_MS,
    CONSENT_VERSION,
    MIN_SESSION_TTL_MS,
    MAX_SESSION_TTL_MS,
    DEFAULT_IDLE_TIMEOUT_MS,
  ],
  transfers: CollaborationTransfers,
  lease: SessionLease,
};
