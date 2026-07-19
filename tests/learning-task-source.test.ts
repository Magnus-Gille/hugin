import { describe, expect, it } from "vitest";

import { buildAuthenticatedLearningTaskSource } from "../src/learning-task-source.js";

const common = {
  taskNamespace: "tasks/task-1",
  createdAt: "2026-07-19T10:00:00.000Z",
  acceptedAt: "2026-07-19T10:00:01.000Z",
};

describe("learning-task source authority", () => {
  it("never lets an embedded Broker claim override a verified normal submitter", () => {
    expect(buildAuthenticatedLearningTaskSource({
      ...common,
      verifiedSubmitter: "signed-owner",
      brokerPrincipal: "embedded-broker",
      brokerAttestedNamespace: common.taskNamespace,
    })).toMatchObject({
      system: "munin-task",
      principal: { id: "signed-owner", authentication: "verified-signature" },
    });
  });

  it("accepts Broker provenance only with exact namespace binding", () => {
    expect(buildAuthenticatedLearningTaskSource({
      ...common,
      brokerPrincipal: "broker-owner",
      brokerAttestedNamespace: common.taskNamespace,
    })).toMatchObject({
      system: "hugin-broker",
      principal: { id: "broker-owner", authentication: "service-auth" },
    });
    expect(() => buildAuthenticatedLearningTaskSource({
      ...common,
      brokerPrincipal: "broker-owner",
      brokerAttestedNamespace: "tasks/other",
    })).toThrow(/namespace mismatch/);
  });
});
