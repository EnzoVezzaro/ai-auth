export interface CollaborationWheelTransfers {
  sendText(text: string): Promise<unknown>;
  sendElement(metadata: Record<string, unknown>): Promise<unknown>;
  sendAttachment(
    blob: Blob,
    options: { kind: "screenshot" | "recording"; name: string },
  ): Promise<unknown>;
  subscribe(
    listener: (event: {
      type: string;
      text?: string;
      metadata?: Record<string, unknown>;
      blob?: Blob;
      name?: string;
      issuer?: string;
    }) => void,
  ): () => void;
}

/** Mount the wheel for an approved connection. Returns a function that removes it. */
export function mountCollaborationWheel(
  transfers: CollaborationWheelTransfers,
  options?: { target?: HTMLElement; capabilities?: readonly string[] | null },
): () => void;
