export const SENSITIVE_SELECTOR: string;
/** True for password, credential-autocomplete, contenteditable, `[data-private]` and `[data-ai-auth-private]` elements and anything inside them. */
export function isSensitiveElement(element: unknown): boolean;
export function extractSafeText(
  element: unknown,
  options?: { max?: number },
): { text: string; omitted: number };
