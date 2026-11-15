import {
  onVerifiedPageConnectionClose,
  readVerifiedPageConnection,
} from "./session.js";

function actionCapability(type) {
  if (type === "tools.invoke") return "tools.invoke";
  throw new TypeError("Page tools require the tools.invoke capability");
}

function validateAction(action) {
  if (
    !action ||
    !/^[a-z][a-z0-9._-]{0,63}$/u.test(action.name ?? "") ||
    typeof action.description !== "string" ||
    !action.description.trim() ||
    typeof action.execute !== "function" ||
    !action.inputSchema ||
    action.inputSchema.type !== "object" ||
    !action.inputSchema.properties ||
    typeof action.requiredCapability !== "string"
  ) {
    throw new TypeError(
      "Page actions need a name, description, object input schema, capability, and execute function",
    );
  }
  actionCapability(action.requiredCapability);
}

export async function registerAIAuthPageActions({
  actions,
  connection,
  modelContext = globalThis.document?.modelContext,
  signal,
  publishAction = async () => {},
} = {}) {
  if (!Array.isArray(actions))
    throw new TypeError("Page actions must be an array");
  const verifiedConnection = readVerifiedPageConnection(connection);
  if (!verifiedConnection)
    throw new TypeError(
      "A verified, active AI Auth wallet connection is required",
    );
  const approved = new Set(verifiedConnection.capabilities);
  const allowedActions = actions.filter((action) => {
    validateAction(action);
    return approved.has(action.requiredCapability);
  });
  const handlers = new Map(
    allowedActions.map((action) => [action.name, action]),
  );
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  const registrationSignal = controller.signal;
  const expiresInMs = Math.max(0, verifiedConnection.expiresAt - Date.now());
  const expiryTimer = setTimeout(() => controller.abort(), expiresInMs);
  const removeConnectionCloseListener = onVerifiedPageConnectionClose(
    connection,
    () => controller.abort(),
  );
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(expiryTimer);
    signal?.removeEventListener("abort", abortFromCaller);
    removeConnectionCloseListener();
    controller.abort();
  };

  async function execute(name, input, { signal: executionSignal } = {}) {
    const action = handlers.get(name);
    const activeConnection = readVerifiedPageConnection(connection);
    if (
      closed ||
      registrationSignal.aborted ||
      !action ||
      !activeConnection?.capabilities.includes(action.requiredCapability)
    )
      return { error: "This action is not approved for this page" };
    const event = {
      name: action.name,
      capability: action.requiredCapability,
      state: "started",
      summary: `Started ${action.name}`,
    };
    try {
      await publishAction(event);
      const stillAuthorized = readVerifiedPageConnection(connection);
      if (
        closed ||
        registrationSignal.aborted ||
        !stillAuthorized?.capabilities.includes(action.requiredCapability)
      )
        return { error: "This action is not approved for this page" };
      const result = await action.execute(input ?? {}, {
        signal: executionSignal,
      });
      await publishAction({
        ...event,
        state: "completed",
        summary: `Completed ${action.name}`,
      });
      return result;
    } catch {
      try {
        await publishAction({
          ...event,
          state: "failed",
          summary: `Could not complete ${action.name}`,
        });
      } catch {
        // Page event transport errors may contain secrets; keep them out of tool results.
      }
      return {
        error: "This page action failed. Check the site for details.",
      };
    }
  }

  const webMcpAvailable = Boolean(modelContext?.registerTool);
  if (webMcpAvailable) {
    try {
      await Promise.all(
        allowedActions.map((action) =>
          modelContext.registerTool(
            {
              name: action.name,
              description: action.description,
              inputSchema: action.inputSchema,
              annotations: {
                readOnlyHint: action.readOnly === true,
              },
              execute: (input, context = {}) =>
                execute(action.name, input, context),
            },
            { signal: registrationSignal },
          ),
        ),
      );
    } catch (error) {
      close();
      throw error;
    }
  }

  return Object.freeze({
    webMcpAvailable,
    tools: Object.freeze(allowedActions.map(({ name }) => name)),
    execute,
    close,
  });
}
