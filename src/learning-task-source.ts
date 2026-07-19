import type { LearningTaskSource } from "./learning-task-handshake.js";

export function buildAuthenticatedLearningTaskSource(input: {
  taskNamespace: string;
  createdAt: string;
  acceptedAt: string;
  verifiedSubmitter?: string;
  brokerPrincipal?: string;
  brokerAttestedNamespace?: string;
  brokerAttestationError?: string;
}): LearningTaskSource {
  const createdAt = new Date(input.createdAt).toISOString();
  const acceptedAt = new Date(input.acceptedAt).toISOString();
  // An ordinary signed task is owned by its verified signer. Embedded Broker
  // claims are data, not authority, and can never override this branch.
  if (input.verifiedSubmitter) {
    return {
      component: "hugin",
      system: "munin-task",
      id: input.taskNamespace,
      created_at: createdAt,
      accepted_at: acceptedAt,
      principal: {
        id: input.verifiedSubmitter,
        authentication: "verified-signature",
        scope: "owner",
      },
      content_owner: {
        id: input.verifiedSubmitter,
        authority: "authenticated-owner",
      },
    };
  }
  if (input.brokerPrincipal) {
    if (input.brokerAttestedNamespace !== input.taskNamespace) {
      throw new Error("LearningTaskContract Broker attestation namespace mismatch");
    }
    return {
      component: "hugin",
      system: "hugin-broker",
      id: input.taskNamespace,
      created_at: createdAt,
      accepted_at: acceptedAt,
      principal: {
        id: input.brokerPrincipal,
        authentication: "service-auth",
        scope: "owner",
      },
      content_owner: {
        id: input.brokerPrincipal,
        authority: "authenticated-owner",
      },
    };
  }
  throw new Error(input.brokerAttestationError
    ? `LearningTaskContract Broker source rejected: ${input.brokerAttestationError}`
    : "LearningTaskContract requires an authenticated Broker principal or valid task signature");
}
