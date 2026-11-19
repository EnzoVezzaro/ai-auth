import type { Protocol, UnifiedToolDescriptor } from "./tool-descriptor.js";
import type { InvocationContext, RegistryFilter } from "./tool-registry.js";

export interface ProviderAdapterShape {
  readonly protocol?: Protocol;
  discover(): Promise<readonly UnifiedToolDescriptor[]>;
  listTools?(...args: unknown[]): Promise<readonly UnifiedToolDescriptor[]>;
  getTool?(id: string): Promise<UnifiedToolDescriptor | undefined>;
}

export type NativeInvoker = (
  descriptor: UnifiedToolDescriptor,
  args: unknown,
  context: InvocationContext,
) => Promise<any>;

export interface UnifiedInvokeResult {
  readonly ok: boolean;
  readonly code?: string;
  readonly reason?: string;
  readonly protocol?: Protocol;
  readonly toolId?: string;
  readonly native?: unknown;
  readonly nativeError?: string;
}

export interface UnifiedToolApi {
  readonly registry: any;
  registerAdapter(
    protocol: Protocol,
    adapter: ProviderAdapterShape,
  ): Promise<readonly UnifiedToolDescriptor[]>;
  listTools(
    context?: InvocationContext,
    filter?: RegistryFilter,
  ): readonly UnifiedToolDescriptor[];
  getTool(id: string): UnifiedToolDescriptor | undefined;
  invoke(
    id: string,
    args: unknown,
    context?: InvocationContext,
  ): Promise<UnifiedInvokeResult>;
}

export declare const UNIFIED_INVOKE_ERRORS: Readonly<{
  DENIED: "DENIED";
  NO_INVOKER: "NO_INVOKER";
  PROVIDER_FAILED: "PROVIDER_FAILED";
}>;

export declare function createUnifiedToolApi(options?: {
  registry?: any;
  adapters?: Partial<Record<Protocol, ProviderAdapterShape>>;
  invokers?: Partial<Record<Protocol, NativeInvoker>>;
}): UnifiedToolApi;
