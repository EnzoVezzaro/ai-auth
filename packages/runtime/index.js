export const PLUGIN_API_VERSION = 2;

export const PLUGIN_SLOTS = Object.freeze([
  "identity",
  "authorization",
  "storage",
  "presence",
  "transport",
  "observability",
]);

export const REQUIRED_PLUGIN_SLOTS = Object.freeze([
  "identity",
  "authorization",
  "storage",
  "presence",
  "transport",
]);

const PLUGIN_METHODS = Object.freeze({
  identity: ["identify"],
  authorization: ["allows"],
  storage: ["getTenant"],
  presence: ["getTenant"],
  transport: ["forwardTenant"],
  observability: ["record"],
});

export class PluginConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PluginConfigurationError";
  }
}

export function createScopeAuthorizationProvider() {
  return Object.freeze({
    allows(subject, capability) {
      return (
        typeof capability === "string" &&
        capability.length > 0 &&
        Array.isArray(subject?.capabilities) &&
        subject.capabilities.includes(capability)
      );
    },
  });
}

export function createCallbackAuthorizationProvider(policy) {
  if (typeof policy !== "function")
    throw new PluginConfigurationError(
      "Authorization policy must be a function",
    );
  return Object.freeze({
    allows(subject, capability, resource) {
      if (typeof capability !== "string" || capability.length === 0)
        return false;
      return policy(subject, capability, resource) === true;
    },
  });
}

function validatePlugins(plugins) {
  if (!Array.isArray(plugins))
    throw new PluginConfigurationError("Plugins must be an array");

  const byId = new Map();
  const bySlot = new Map();
  for (const plugin of plugins) {
    if (!plugin || typeof plugin !== "object")
      throw new PluginConfigurationError("Every plugin must be an object");
    if (
      typeof plugin.id !== "string" ||
      !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(plugin.id)
    ) {
      throw new PluginConfigurationError("Plugin id is invalid");
    }
    if (!PLUGIN_SLOTS.includes(plugin.slot)) {
      throw new PluginConfigurationError(
        `Plugin ${plugin.id} has an unsupported slot`,
      );
    }
    if (plugin.apiVersion !== PLUGIN_API_VERSION) {
      throw new PluginConfigurationError(
        `Plugin ${plugin.id} requires an unsupported API version`,
      );
    }
    if (typeof plugin.initialize !== "function") {
      throw new PluginConfigurationError(
        `Plugin ${plugin.id} must provide initialize(context)`,
      );
    }
    if (!plugin.implementation || typeof plugin.implementation !== "object") {
      throw new PluginConfigurationError(
        `Plugin ${plugin.id} must provide an implementation`,
      );
    }
    for (const method of PLUGIN_METHODS[plugin.slot]) {
      if (typeof plugin.implementation[method] !== "function") {
        throw new PluginConfigurationError(
          `${plugin.slot} plugin implementation must provide ${method}()`,
        );
      }
    }
    if (plugin.close !== undefined && typeof plugin.close !== "function") {
      throw new PluginConfigurationError(
        `Plugin ${plugin.id} close must be a function`,
      );
    }
    if (byId.has(plugin.id))
      throw new PluginConfigurationError(`Plugin id ${plugin.id} is repeated`);
    if (bySlot.has(plugin.slot))
      throw new PluginConfigurationError(
        `Only one plugin may provide the ${plugin.slot} slot`,
      );

    byId.set(plugin.id, plugin);
    bySlot.set(plugin.slot, plugin);
  }
  return { byId, bySlot };
}

function orderPlugins(byId) {
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();

  function visit(plugin) {
    if (visited.has(plugin.id)) return;
    if (visiting.has(plugin.id))
      throw new PluginConfigurationError("Plugin dependencies contain a cycle");
    visiting.add(plugin.id);
    const dependencies = plugin.dependsOn ?? [];
    if (
      !Array.isArray(dependencies) ||
      dependencies.some((id) => typeof id !== "string")
    ) {
      throw new PluginConfigurationError(
        `Plugin ${plugin.id} dependencies must be plugin ids`,
      );
    }
    for (const id of dependencies) {
      const dependency = byId.get(id);
      if (!dependency) {
        throw new PluginConfigurationError(
          `Plugin ${plugin.id} depends on missing plugin ${id}`,
        );
      }
      visit(dependency);
    }
    visiting.delete(plugin.id);
    visited.add(plugin.id);
    ordered.push(plugin);
  }

  for (const plugin of byId.values()) visit(plugin);
  return ordered;
}

/**
 * Initialize one provider for each core slot. A failed startup closes already
 * initialized plugins in reverse dependency order before surfacing the error.
 */
export async function createPluginHost(
  plugins,
  { context = Object.freeze({}), requiredSlots = REQUIRED_PLUGIN_SLOTS } = {},
) {
  const { byId, bySlot } = validatePlugins(plugins);
  if (!Array.isArray(requiredSlots))
    throw new PluginConfigurationError("requiredSlots must be an array");
  for (const slot of requiredSlots) {
    if (!PLUGIN_SLOTS.includes(slot))
      throw new PluginConfigurationError(
        `Required plugin slot ${slot} is invalid`,
      );
    if (!bySlot.has(slot))
      throw new PluginConfigurationError(
        `Required plugin slot ${slot} is missing`,
      );
  }

  const ordered = orderPlugins(byId);
  const attempted = [];
  try {
    for (const plugin of ordered) {
      attempted.push(plugin);
      await plugin.initialize(context);
    }
  } catch {
    const failedPlugin = attempted.at(-1);
    for (const plugin of attempted.reverse()) {
      try {
        await plugin.close?.();
      } catch {
        // Preserve the startup error; cleanup remains best effort.
      }
    }
    throw new Error(`Plugin host startup failed at ${failedPlugin.id}`);
  }

  let closed = false;
  return Object.freeze({
    get(slot) {
      if (!PLUGIN_SLOTS.includes(slot))
        throw new PluginConfigurationError(`Plugin slot ${slot} is invalid`);
      return bySlot.get(slot);
    },
    async close() {
      if (closed) return;
      closed = true;
      const errors = [];
      for (const plugin of [...attempted].reverse()) {
        try {
          await plugin.close?.();
        } catch {
          errors.push(plugin.id);
        }
      }
      if (errors.length)
        throw new AggregateError(
          errors.map((id) => new Error(`Plugin ${id} failed to close`)),
          "One or more plugins failed to close",
        );
    },
  });
}
