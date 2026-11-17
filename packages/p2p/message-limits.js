// Shared chat length cap. Kept import-free so every consumer (SDK validator,
// MCP schema, wheel markup and embed host) can reference it without an ESM cycle.
export const MAX_MESSAGE_CHARS = 4000;
