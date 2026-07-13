/** Authenticated Broker HTTP handlers for the durable learning loop. */

import type { Response } from "express";
import { ZodError } from "zod";
import type { AuthenticatedRequest } from "../broker/auth.js";
import {
  learningExperimentCreateSchema,
  learningExperimentPromoteSchema,
  learningExperimentRateSchema,
  learningExperimentStatusSchema,
  learningObservationSchema,
} from "./experiment-schema.js";
import { LearningStoreError, type LearningExperimentStore } from "./experiment-store.js";

function principalOr500(req: AuthenticatedRequest, res: Response): string | null {
  if (!req.brokerPrincipal) {
    res.status(500).json({ error: "internal", message: "principal missing" });
    return null;
  }
  return req.brokerPrincipal;
}

function respondError(res: Response, err: unknown): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: "input_validation",
      message: "learning-loop input failed validation",
      issues: err.issues,
    });
    return;
  }
  if (err instanceof LearningStoreError) {
    const status =
      err.code === "not-found"
        ? 404
        : err.code === "forbidden"
          ? 403
          : err.code === "conflict" || err.code === "invalid-state" || err.code === "capacity"
            ? 409
            : 500;
    res.status(status).json({ error: err.code, message: err.message });
    return;
  }
  res.status(500).json({
    error: "internal",
    message: err instanceof Error ? err.message : String(err),
  });
}

export function createLearningExperimentHandler(store: LearningExperimentStore) {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const principal = principalOr500(req, res);
    if (!principal) return;
    try {
      const input = learningExperimentCreateSchema.parse(req.body);
      const result = await store.create(principal, input);
      res.status(result.reused ? 200 : 201).json(result);
    } catch (err) {
      respondError(res, err);
    }
  };
}

export function createLearningObservationHandler(store: LearningExperimentStore) {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const principal = principalOr500(req, res);
    if (!principal) return;
    try {
      const input = learningObservationSchema.parse(req.body);
      const result = await store.observe(principal, input);
      res.status(200).json(result);
    } catch (err) {
      respondError(res, err);
    }
  };
}

export function createLearningExperimentRateHandler(store: LearningExperimentStore) {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const principal = principalOr500(req, res);
    if (!principal) return;
    try {
      const input = learningExperimentRateSchema.parse(req.body);
      const result = await store.rate(principal, input);
      res.status(200).json(result);
    } catch (err) {
      respondError(res, err);
    }
  };
}

export function createLearningExperimentStatusHandler(store: LearningExperimentStore) {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const principal = principalOr500(req, res);
    if (!principal) return;
    try {
      const input = learningExperimentStatusSchema.parse(req.body);
      const state = await store.read(principal, input.experiment_id);
      res.status(200).json({ state });
    } catch (err) {
      respondError(res, err);
    }
  };
}

export function createLearningExperimentPromoteHandler(store: LearningExperimentStore) {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const principal = principalOr500(req, res);
    if (!principal) return;
    try {
      const input = learningExperimentPromoteSchema.parse(req.body);
      const result = await store.promote(principal, input);
      res.status(200).json(result);
    } catch (err) {
      respondError(res, err);
    }
  };
}
