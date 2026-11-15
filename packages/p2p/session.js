const verifiedPageConnections = new WeakMap();

export function markVerifiedPageConnection(connection, consent) {
  if (
    !connection ||
    typeof connection !== "object" ||
    !Array.isArray(consent?.body?.payload?.capabilities) ||
    !Number.isFinite(consent.body.payload.expiresAt)
  )
    throw new TypeError("A verified wallet consent is required");
  verifiedPageConnections.set(connection, {
    capabilities: Object.freeze([...consent.body.payload.capabilities]),
    expiresAt: consent.body.payload.expiresAt,
    closeListeners: new Set(),
  });
}

export function readVerifiedPageConnection(connection, now = Date.now()) {
  const record = verifiedPageConnections.get(connection);
  if (!record) return null;
  if (record.expiresAt <= now) {
    revokeVerifiedPageConnection(connection);
    return null;
  }
  return record;
}

export function onVerifiedPageConnectionClose(connection, listener) {
  const record = readVerifiedPageConnection(connection);
  if (!record) {
    listener();
    return () => {};
  }
  record.closeListeners.add(listener);
  return () => record.closeListeners.delete(listener);
}

export function revokeVerifiedPageConnection(connection) {
  const record = verifiedPageConnections.get(connection);
  if (!record) return;
  verifiedPageConnections.delete(connection);
  for (const listener of record.closeListeners) {
    try {
      listener();
    } catch {
      // Closing a page connection must continue if a registered tool fails to close.
    }
  }
  record.closeListeners.clear();
}
