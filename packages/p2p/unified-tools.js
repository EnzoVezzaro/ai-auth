// One API for listing and invoking tools from MCP, WebMCP and UTCP.
//
// The registry decides and records. Native execution stays with the host's
// provider-specific invokers, so no protocol's authorization or error semantics
// are replaced by a generic AI Auth grant. This module adds no protocol and no
// new privileges.

import { createToolRegistry } from "./tool-registry.js";

export const UNIFIED_INVOKE_ERRORS = Object.freeze({
  DENIED: "DENIED",
  NO_INVOKER: "NO_INVOKER",
  PROVIDER_FAILED: "PROVIDER_FAILED",
});

/**
 * @param {object} options
 * @param {ReturnType<typeof createToolRegistry>} [options.registry]
 * @param {Record<string, object>} [options.adapters] protocol -> adapter with discover/listTools/getTool
 * @param {Record<string, function>} [options.invokers] protocol -> async (descriptor, args, ctx) => result
 */
export function createUnifiedToolApi({
  registry = createToolRegistry(),
  adapters = {},
  invokers = {},
} = {}) {
  const registered = new Map();

  /** Register descriptors from an adapter's discovery result. */
  async function registerAdapter(protocol, adapter) {
    if (!adapter || typeof adapter.discover !== "function")
      throw new TypeError("adapter.discover() is required");
    const descriptors = await adapter.discover();
    const added = [];
    for (const descriptor of descriptors) {
      if (descriptor.protocol !== protocol)
        throw new TypeError(
          `adapter protocol ${protocol} emitted ${descriptor.protocol} descriptor`,
        );
      added.push(registry.register(descriptor));
      registered.set(descriptor.id, protocol);
    }
    return added;
  }

  // The gate already records the static decision. Only append an outcome row
  // when the call did not complete cleanly, so audit never claims an invocation
  // that never happened and does not waste the bounded ring on duplicates.
  function recordFailure(descriptor, protocol, id, ctx, outcome) {
    registry.audit.record({
      caller: ctx.caller,
      providerId: descriptor.providerId,
      protocol,
      toolId: id,
      decision: "deny",
      outcome,
    });
  }

  /** List tools that pass the static checks. The policy hook is applied at invoke time. */
  function listTools(ctx = {}, filter = {}) {
    return registry
      .list(filter)
      .filter((tool) => registry.match(tool.id, ctx).ok);
  }

  function getTool(id) {
    return registry.get(id);
  }

  /**
   * Gate the call, then dispatch through the native invoker for its protocol.
   * A missing invoker fails closed; native errors are preserved verbatim in
   * `nativeError` and never rewritten into a broader permission.
   */
  async function invoke(id, args, ctx = {}) {
    const gate = await registry.invokeGate(id, ctx);
    if (!gate.allowed)
      return Object.freeze({
        ok: false,
        code: UNIFIED_INVOKE_ERRORS.DENIED,
        reason: gate.reason,
      });

    const descriptor = registry.get(id);
    const protocol = descriptor.protocol ?? registered.get(id);
    const invoker = invokers[protocol];
    if (typeof invoker !== "function") {
      recordFailure(descriptor, protocol, id, ctx, "no-invoker");
      return Object.freeze({
        ok: false,
        code: UNIFIED_INVOKE_ERRORS.NO_INVOKER,
        protocol,
        toolId: id,
      });
    }

    try {
      const native = await invoker(descriptor, args, ctx);
      if (native?.ok === false)
        recordFailure(descriptor, protocol, id, ctx, "native_error");
      return Object.freeze({
        ok: native?.ok !== false,
        protocol,
        toolId: id,
        native,
      });
    } catch (error) {
      recordFailure(descriptor, protocol, id, ctx, "provider_failed");
      return Object.freeze({
        ok: false,
        code: UNIFIED_INVOKE_ERRORS.PROVIDER_FAILED,
        protocol,
        toolId: id,
        nativeError: String(error?.message ?? error).slice(0, 240),
      });
    }
  }

  return Object.freeze({
    registry,
    registerAdapter,
    listTools,
    getTool,
    invoke,
  });
}
