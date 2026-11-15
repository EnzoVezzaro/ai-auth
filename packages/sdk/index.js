import "./ai-auth.js";

const AIAuth = globalThis.AIAuth;
if (!AIAuth) throw new Error("AI Auth SDK requires a browser window");

export { AIAuth };
export default AIAuth;
