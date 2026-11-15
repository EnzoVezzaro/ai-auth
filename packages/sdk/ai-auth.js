(function (global) {
  const listeners = new Set();
  const localTools = new Map();
  const webmcpControllers = new Set();
  let config = {};
  let socket;
  const endpoint = (path) =>
    new URL(
      path,
      config.baseUrl || document.currentScript?.src || location.origin,
    ).toString();
  async function request(path, options = {}) {
    if (!config.token)
      throw new Error("AI Auth requires a short-lived agent token");
    const response = await fetch(endpoint(path), {
      ...options,
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
        ...options.headers,
      },
    });
    if (!response.ok)
      throw new Error(`AI Auth request failed (${response.status})`);
    return response.status === 204 ? undefined : response.json();
  }
  async function connect() {
    const { ticket } = await request("/v1/events/ticket", {
      method: "POST",
      body: JSON.stringify({ room: config.room }),
    });
    const url = new URL(endpoint("/v1/events"));
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("ticket", ticket);
    socket = new WebSocket(url);
    socket.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      listeners.forEach((fn) => fn(data));
    };
    socket.onopen = () => {
      const beat = setInterval(
        () => socket?.readyState === WebSocket.OPEN && socket.send("ping"),
        15_000,
      );
      socket.addEventListener("close", () => clearInterval(beat), {
        once: true,
      });
    };
  }
  const api = {
    init(options = {}) {
      config = { ...config, room: "workspace", ...options };
      if (!config.baseUrl)
        config.baseUrl = new URL(
          document.currentScript?.src || location.href,
        ).origin;
      if (config.token && config.autoConnect !== false) {
        connect().catch((error) =>
          console.error("AI Auth connection failed", error),
        );
      }
      return api;
    },
    destroy() {
      socket?.close();
      socket = undefined;
      listeners.clear();
      webmcpControllers.forEach((controller) => controller.abort());
      webmcpControllers.clear();
      localTools.clear();
    },
    agent: {
      async joinRoom(room) {
        config.room = room;
        if (socket) api.destroy();
        if (config.token) await connect();
        return { room };
      },
      async setStatus(status) {
        return request("/v1/status", {
          method: "POST",
          body: JSON.stringify({ status }),
        });
      },
      async setActivity(activity) {
        return request("/v1/activity", {
          method: "POST",
          body: JSON.stringify({ activity }),
        });
      },
      async whoami() {
        return request("/v1/me");
      },
    },
    presence: {
      subscribe(callback) {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
      async list(room = config.room) {
        return request(`/v1/presence?room=${encodeURIComponent(room)}`);
      },
    },
    collaboration: {
      async sendMessage(message, room = config.room) {
        return request(`/v1/rooms/${encodeURIComponent(room)}/messages`, {
          method: "POST",
          body: JSON.stringify({ body: message }),
        });
      },
      async requestHandoff(description, assigneeId, room = config.room) {
        return request(`/v1/rooms/${encodeURIComponent(room)}/tasks`, {
          method: "POST",
          body: JSON.stringify({ description, assigneeId }),
        });
      },
      async acquireLock(resource, leaseSeconds = 60, room = config.room) {
        return request(`/v1/rooms/${encodeURIComponent(room)}/locks`, {
          method: "POST",
          body: JSON.stringify({ resource, leaseSeconds }),
        });
      },
      async releaseLock(resource, room = config.room) {
        return request(
          `/v1/rooms/${encodeURIComponent(room)}/locks/${encodeURIComponent(resource)}`,
          { method: "DELETE" },
        );
      },
    },
    analytics: {
      async track(name, properties = {}) {
        return request("/v1/analytics/events", {
          method: "POST",
          body: JSON.stringify({ name, properties }),
        });
      },
    },
    webmcp: {
      async registerTool(tool, options = {}) {
        if (
          !tool ||
          !/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name || "") ||
          !tool.description ||
          typeof tool.execute !== "function"
        )
          throw new TypeError(
            "tool needs a valid name, description, and execute callback",
          );
        if (global.document?.modelContext?.registerTool) {
          const controller = new AbortController();
          webmcpControllers.add(controller);
          await global.document.modelContext.registerTool(tool, {
            ...options,
            signal: controller.signal,
          });
          return {
            native: true,
            name: tool.name,
            dispose: () => {
              controller.abort();
              webmcpControllers.delete(controller);
            },
          };
        }
        if (localTools.has(tool.name))
          throw new Error(`tool already registered: ${tool.name}`);
        localTools.set(tool.name, tool);
        return {
          native: false,
          name: tool.name,
          dispose: () => localTools.delete(tool.name),
        };
      },
      listTools() {
        return global.document?.modelContext?.getTools
          ? global.document.modelContext.getTools()
          : Promise.resolve(
              [...localTools.values()].map(
                ({ name, title, description, inputSchema }) => ({
                  name,
                  title,
                  description,
                  inputSchema,
                }),
              ),
            );
      },
      async executeTool(name, input = {}) {
        const tool = localTools.get(name);
        if (tool)
          return tool.execute(input, { signal: new AbortController().signal });
        if (
          global.document?.modelContext?.getTools &&
          global.document.modelContext.executeTool
        ) {
          const tools = await global.document.modelContext.getTools();
          const found = tools.find((item) => item.name === name);
          if (found)
            return global.document.modelContext.executeTool(found, input);
        }
        throw new Error(`tool is not available: ${name}`);
      },
      get nativeAvailable() {
        return Boolean(global.document?.modelContext?.registerTool);
      },
    },
  };
  global.AIAuth = api;
  const script = document.currentScript;
  if (script?.dataset.site)
    api.init({
      site: script.dataset.site,
      baseUrl: new URL(script.src).origin,
      token: script.dataset.token || undefined,
    });
})(window);
