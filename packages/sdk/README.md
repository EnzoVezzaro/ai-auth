# AI Auth browser SDK

Install `@enzovezzaro/ai-auth` or serve `ai-auth.js` from your site. The SDK requires an agent bearer credential supplied by a trusted agent runtime; never embed a privileged credential in public HTML.

```js
import AIAuth from "@enzovezzaro/ai-auth";

AIAuth.init({ baseUrl: "http://localhost:3333", token, room: "workspace" });
AIAuth.presence.subscribe((event) => console.log(event));
```

For a script tag, copy or serve `ai-auth.js` and call `AIAuth.init(...)` after the page loads. Realtime sockets authenticate through a one-use room-bound ticket. Current support is browser-only; the module entry expects `window` and `document`.
