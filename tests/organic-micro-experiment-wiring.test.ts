import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dispatcher = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

describe("organic micro-experiment dispatcher wiring", () => {
  it("pins the challenger model, preserves the baseline token cap, and freezes the plan clock", () => {
    expect(dispatcher).toMatch(/createdAt: startedAt/);
    expect(dispatcher).toMatch(/const baselineMaxTokens = task\.maxOutputTokens as number/);
    expect(dispatcher).toMatch(/maxCompletionTokens: baselineMaxTokens/);
    expect(dispatcher).toMatch(/organicVerifierDigestMatches\(task\.homeserverVerifier, config\.organicOracleDigest\)/);
    expect(dispatcher).toMatch(/organicBaselineModelMatchesTask\(config\.organicBaselineModel, task\.model\)/);
    expect(dispatcher).toMatch(/organicBaselineModelMatchesResult\(\s*config\.organicBaselineModel,\s*homeserverResult\.modelId,?\s*\)/);
    expect(dispatcher).toMatch(/shadowWallBudgetForBaselineTimeout\(task\.timeoutMs\)/);
    expect(dispatcher).toMatch(/modelId: config\.organicChallengerModel/);
    expect(dispatcher).toMatch(/maxTokens: shadowPlan\.execution\.max_completion_tokens/);

    const planDecision = dispatcher.indexOf("const proposedOrganicPlan = organicPlanForTask(");
    const baselinePreparation = dispatcher.indexOf("const preparedLearningTask =", planDecision);
    expect(planDecision).toBeGreaterThan(-1);
    expect(planDecision).toBeLessThan(baselinePreparation);
  });

  it("uses a dedicated shadow client, distinct log identity, and terminal ordering", () => {
    const shadowStart = dispatcher.indexOf("const shadowLogId = `organic-shadow-");
    const shadowEnd = dispatcher.indexOf("currentOllamaAbort = null;", shadowStart);
    const shadowBlock = dispatcher.slice(shadowStart, shadowEnd);
    expect(shadowBlock).toMatch(/organicMicroExperimentMunin/);
    expect(shadowBlock).toMatch(/executeHomeserverTask\([\s\S]*?shadowLogId, LOG_DIR/);
    expect(shadowBlock).toMatch(/Date\.now\(\) - shadowStartedAtMs/);
    expect(shadowBlock).toMatch(/classifyOrganicLearningTaskAdmission\(/);
    expect(shadowBlock).toMatch(/timeoutMs: task\.timeoutMs/);
    expect(shadowBlock).toMatch(/shadowDeadline/);
    expect(shadowBlock).toMatch(/const cleanupController = new AbortController\(\)/);
    expect(shadowBlock).toMatch(/signal: cleanupController\.signal/);
    expect(shadowBlock).toMatch(/shadowBudgetExceeded/);
    expect(dispatcher).toMatch(/reconcileOrganicOrphanPlans\(/);
    expect(dispatcher).toMatch(/shadowActive: \(plan\) => organicShadowQueue\.has\(plan\.experiment_id\)/);
    expect(dispatcher).toMatch(/truncated/);

    const terminalCommit = dispatcher.lastIndexOf("terminalStructuredResultOk = finalizeOutcome.structuredResultOk;");
    const enqueue = dispatcher.lastIndexOf("void enqueueOrganicShadowAfterBaseline({");
    const orphanInvalidation = dispatcher.lastIndexOf("if (terminalStructuredResultOk && organicOrphanPlan && homeserverResult)");
    expect(terminalCommit).toBeGreaterThan(-1);
    expect(terminalCommit).toBeLessThan(enqueue);
    expect(enqueue).toBeLessThan(orphanInvalidation);
    expect(dispatcher.slice(orphanInvalidation)).toMatch(/persistOrganicOrphanInvalidAfterBaseline/);
    expect(dispatcher.slice(orphanInvalidation)).toMatch(/persistOrganicResultForTask/);

    const recoveryStart = dispatcher.indexOf("async function reconcileOrganicOrphanPlans");
    const recoveryEnd = dispatcher.indexOf("async function pollLoop", recoveryStart);
    expect(recoveryStart).toBeGreaterThan(-1);
    expect(dispatcher.slice(recoveryStart, recoveryEnd)).not.toMatch(
      /if \(!config\.organicMicroExperimentEnabled\) return/,
    );
  });
});
