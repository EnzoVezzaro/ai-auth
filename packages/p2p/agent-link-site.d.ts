export type AIAuthAgentLinkPhase =
  "idle" | "checking" | "needs-link" | "connected";

export interface AIAuthLinkedAgent {
  readonly id: string;
  readonly name: string;
  readonly capabilities: readonly string[];
  readonly connectedAt?: number;
  readonly linkedAt?: number;
}

export interface AIAuthAgentLinkState {
  readonly phase: AIAuthAgentLinkPhase;
  readonly siteName: string;
  readonly origin: string;
  readonly room: string;
  readonly siteKey: string | null;
  readonly link: { readonly url: string; readonly expiresAt: number } | null;
  readonly agents: readonly AIAuthLinkedAgent[];
  readonly remembered: readonly AIAuthLinkedAgent[];
}

export interface AIAuthAgentLinkController {
  start(): Promise<void>;
  /** The Connect button: re-verify remembered agents, else show a fresh link. */
  check(): Promise<AIAuthAgentLinkState>;
  createLink(): AIAuthAgentLinkState["link"];
  /** A page connection for mountAIAuthInPageAgent; only connected agents may call tools. */
  toolConnection(): object;
  readonly state: AIAuthAgentLinkState;
  agent(id: string | undefined): AIAuthLinkedAgent | null;
  onChange(listener: (state: AIAuthAgentLinkState) => void): () => void;
  forget(id: string): void;
  close(): Promise<void>;
}

export declare function createAIAuthAgentLink(options: {
  siteName: string;
  capabilities: readonly string[];
  room?: string;
  origin?: string;
  linkBaseUrl?: string;
  storage?: Pick<Storage, "getItem" | "setItem">;
  linkTtlMs?: number;
  checkTimeoutMs?: number;
  openRoom?: (options: {
    origin: string;
    room: string;
    capabilities: string[];
    siteName: string;
  }) => Promise<{ room: unknown; close(): Promise<void> }>;
  now?: () => number;
}): AIAuthAgentLinkController;

export declare function mountAIAuthAgentConnect(options: {
  controller: AIAuthAgentLinkController;
  button: HTMLElement;
  agentCommand?: string;
  document?: Document;
}): {
  readonly dialog: HTMLDialogElement;
  open(): Promise<void>;
  close(): void;
};
