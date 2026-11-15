import { randomNonce, signEnvelope, verifyEnvelope } from "./index.js";

function assertCapabilityList(values) {
  if (!Array.isArray(values) || values.length === 0)
    throw new TypeError("At least one capability is required");
  if (values.includes("*"))
    throw new TypeError("Capability wildcards are not supported");
  if (
    new Set(values).size !== values.length ||
    values.some(
      (value) =>
        typeof value !== "string" ||
        !/^[a-z][a-z0-9]*(?:[.:/_-][a-z0-9]+)*$/u.test(value),
    )
  ) {
    throw new TypeError("Capabilities must be unique explicit operation names");
  }
  return [...values].sort();
}

export async function createCapabilityGrant(
  issuerWallet,
  { recipient, resource, capabilities, expiresAt },
) {
  if (typeof recipient !== "string" || !recipient.startsWith("agent:"))
    throw new TypeError("Recipient must be an agent public-key identity");
  if (
    typeof resource !== "string" ||
    resource.length < 1 ||
    resource.length > 512
  )
    throw new TypeError("Grant needs a resource identifier");
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now() ||
    expiresAt > Date.now() + 30 * 24 * 60 * 60 * 1000
  ) {
    throw new RangeError("Grant expiry must be within the next 30 days");
  }
  return signEnvelope(issuerWallet, "capability/grant", {
    recipient,
    resource,
    capabilities: assertCapabilityList(capabilities),
    grantId: randomNonce(),
    issuedAt: Date.now(),
    expiresAt,
  });
}

export async function verifyCapabilityGrant(
  grant,
  {
    expectedIssuer,
    expectedRecipient,
    resource,
    requiredCapability,
    now = Date.now(),
  } = {},
) {
  if (
    typeof expectedIssuer !== "string" ||
    !expectedIssuer.startsWith("agent:") ||
    typeof expectedRecipient !== "string" ||
    !expectedRecipient.startsWith("agent:") ||
    typeof resource !== "string" ||
    resource.length < 1 ||
    resource.length > 512 ||
    typeof requiredCapability !== "string" ||
    !/^[a-z][a-z0-9]*(?:[.:/_-][a-z0-9]+)*$/u.test(requiredCapability)
  )
    return false;
  if (
    !(await verifyEnvelope(grant, {
      expectedIssuer,
      now,
      maxAgeMs: 31 * 24 * 60 * 60 * 1000,
    }))
  )
    return false;
  const payload = grant.body.payload;
  if (grant.body.type !== "capability/grant") return false;
  if (expectedRecipient && payload.recipient !== expectedRecipient)
    return false;
  if (resource && payload.resource !== resource) return false;
  if (
    !Number.isFinite(payload.issuedAt) ||
    payload.issuedAt > now + 30_000 ||
    payload.expiresAt <= now
  )
    return false;
  if (payload.expiresAt - payload.issuedAt > 30 * 24 * 60 * 60 * 1000)
    return false;
  try {
    assertCapabilityList(payload.capabilities);
  } catch {
    return false;
  }
  return payload.capabilities.includes(requiredCapability);
}
