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

export function renewVerifiedPageConnection(connection, consent) {
  const record = verifiedPageConnections.get(connection);
  const capabilities = consent?.body?.payload?.capabilities;
  if (
    !record ||
    !Array.isArray(capabilities) ||
    !Number.isFinite(consent.body.payload.expiresAt) ||
    capabilities.some((capability) => !record.capabilities.includes(capability))
  )
    throw new TypeError("A verified renewal of this connection is required");
  record.capabilities = Object.freeze([...capabilities]);
  record.expiresAt = consent.body.payload.expiresAt;
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
