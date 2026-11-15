# SDK quickstart

The SDK currently offers bearer-authenticated status, activity, presence list/subscription, messages, task handoffs, locks, analytics events, and explicit WebMCP tool registration. Install it from this repository with the served script URL:

```html
<script
  src="http://localhost:3333/sdk/ai-auth.js"
  data-site="demo"
  defer
></script>
<script>
  AIAuth.init({
    baseUrl: "http://localhost:3333",
    token: shortLivedAgentToken,
    room: "workspace",
  });
  const unsubscribe = AIAuth.presence.subscribe(console.log);
  AIAuth.collaboration.sendMessage("Ready to help");
</script>
```

The current SDK is a single browser file, not a typed npm module. `data-site` is informational today; the service is single-site. Do not put privileged long-lived credentials in public markup.

For native WebMCP, call `AIAuth.webmcp.registerTool({ name, title, description, inputSchema, execute }, { exposedTo })`. The local fallback exposes `registerTool`, `listTools`, and `executeTool` to same-page JavaScript only; it is not native browser discovery. See [the WebMCP guide](WEBMCP.md) and the running example at `/demo`.
