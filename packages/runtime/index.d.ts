export declare const PLUGIN_API_VERSION: 2;

export declare const PLUGIN_SLOTS: readonly [
  "identity",
  "authorization",
  "storage",
  "presence",
  "transport",
  "observability",
];

export declare const REQUIRED_PLUGIN_SLOTS: readonly [
  "identity",
  "authorization",
  "storage",
  "presence",
  "transport",
];

export type PluginSlot = (typeof PLUGIN_SLOTS)[number];

export interface IdentityProvider {
  identify(publicKey: unknown): string | Promise<string>;
}

export interface AuthorizationProvider<Subject = unknown> {
  allows(subject: Subject, capability: string, resource?: unknown): boolean;
}

export interface TenantProvider<Tenant = unknown> {
  getTenant(tenantId: string): Tenant;
}

export interface TenantTransport<
  Tenant = unknown,
  Request = unknown,
  Response = unknown,
> {
  forwardTenant(
    tenant: Tenant,
    path: string,
    method: string,
    data: Readonly<Record<string, unknown>>,
    request: Request,
  ): Response | Promise<Response>;
}

export interface ObservabilityProvider {
  record(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface PluginImplementationBySlot {
  identity: IdentityProvider;
  authorization: AuthorizationProvider;
  storage: TenantProvider;
  presence: TenantProvider;
  transport: TenantTransport;
  observability: ObservabilityProvider;
}

export interface AIAuthPlugin<Slot extends PluginSlot, Context = unknown> {
  readonly id: string;
  readonly slot: Slot;
  readonly apiVersion: typeof PLUGIN_API_VERSION;
  readonly dependsOn?: readonly string[];
  readonly implementation: PluginImplementationBySlot[Slot];
  initialize(context: Context): void | Promise<void>;
  close?(): void | Promise<void>;
}

export type AnyAIAuthPlugin<Context = unknown> = {
  [Slot in PluginSlot]: AIAuthPlugin<Slot, Context>;
}[PluginSlot];

export interface PluginHost {
  get<Slot extends PluginSlot>(slot: Slot): AIAuthPlugin<Slot> | undefined;
  close(): Promise<void>;
}

export declare class PluginConfigurationError extends Error {}

export declare function createPluginHost<Context = unknown>(
  plugins: readonly AnyAIAuthPlugin<Context>[],
  options?: {
    context?: Context;
    requiredSlots?: readonly PluginSlot[];
  },
): Promise<PluginHost>;

export declare function createScopeAuthorizationProvider<
  Subject extends { capabilities?: readonly string[] } = {
    capabilities?: readonly string[];
  },
>(): AuthorizationProvider<Subject>;

export declare function createCallbackAuthorizationProvider<Subject = unknown>(
  policy: (subject: Subject, capability: string, resource?: unknown) => boolean,
): AuthorizationProvider<Subject>;
