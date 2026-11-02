/**
 * Broker HTTP server (orchestrator v1).
 *
 * Mounts the five `/v1/delegate/*` handlers, the shared friction endpoint, and
 * optional versioned-learning handlers behind the bearer-token middleware on a
 * separate Express app. The default bind is loopback only;
 * production deployments override `HUGIN_BROKER_HOST` to the Tailscale
 * interface IP. Health is unauthenticated; everything else requires a
 * known principal.
 *
 * The broker is opt-in: if `HUGIN_BROKER_KEYS`/`HUGIN_BROKER_KEYS_FILE`
 * is unset, `startBroker()` returns null and the dispatcher runs without
 * the broker enabled. This keeps the existing health endpoint untouched
 * for hosts that haven't been provisioned with broker keys yet.
 */

import express from "express";
import type { Express, RequestHandler } from "express";
import type { Server } from "node:http";
import {
  brokerAuthMiddleware,
  loadBrokerKeysFromEnv,
  type BrokerKeyStore,
} from "./auth.js";
import {
  createAwaitHandler,
  createFrictionHandler,
  createListHandler,
  createModelsHandler,
  createRateHandler,
  createSubmitHandler,
  type BrokerHandlerDependencies,
} from "./handlers.js";
import {
  createLearningExperimentHandler,
  createLearningExperimentPromoteHandler,
  createLearningExperimentRateHandler,
  createLearningExperimentStatusHandler,
  createLearningObservationHandler,
} from "../learning/experiment-handlers.js";
import type { LearningExperimentStore } from "../learning/experiment-store.js";

export interface BrokerServerConfig {
  host: string;
  port: number;
  keys: BrokerKeyStore;
  deps: BrokerHandlerDependencies;
  learningStore?: LearningExperimentStore;
}

export function buildBrokerApp(config: BrokerServerConfig): Express {
  const app = express();

  app.get("/health", (_req, res) => {
    const traceIngress = config.deps.traceIngressCounter?.snapshot();
    res.json({
      status: "ok",
      service: "hugin-broker",
      principals: Object.keys(config.keys),
      ...(traceIngress
        ? {
            trace_ingress: {
              invalid_reasons: {
                forbidden_baggage: traceIngress.invalidReasons.forbiddenBaggage,
                malformed_traceparent: traceIngress.invalidReasons.malformedTraceparent,
              },
            },
          }
        : {}),
    });
  });

  const auth = brokerAuthMiddleware(config.keys);
  const protectedMiddleware: RequestHandler[] = [
    auth,
    express.json({ limit: "2mb" }),
  ];
  const protectedRoute = (handler: RequestHandler): RequestHandler[] => [
    ...protectedMiddleware,
    handler,
  ];

  app.post(
    "/v1/delegate/submit",
    ...protectedRoute(createSubmitHandler(config.deps)),
  );
  app.post(
    "/v1/delegate/await",
    ...protectedRoute(createAwaitHandler(config.deps)),
  );
  app.post(
    "/v1/delegate/rate",
    ...protectedRoute(createRateHandler(config.deps)),
  );
  app.post(
    "/v1/friction/report",
    ...protectedRoute(createFrictionHandler(config.deps)),
  );
  app.post(
    "/v1/delegate/list",
    ...protectedRoute(createListHandler(config.deps)),
  );
  app.get(
    "/v1/delegate/list",
    ...protectedRoute(createListHandler(config.deps)),
  );
  app.get(
    "/v1/delegate/models",
    ...protectedRoute(createModelsHandler(config.deps.executorCapabilities)),
  );
  if (config.learningStore) {
    app.post(
      "/v1/learning/experiments/create",
      ...protectedRoute(createLearningExperimentHandler(config.learningStore)),
    );
    app.post(
      "/v1/learning/experiments/observe",
      ...protectedRoute(createLearningObservationHandler(config.learningStore)),
    );
    app.post(
      "/v1/learning/experiments/rate",
      ...protectedRoute(createLearningExperimentRateHandler(config.learningStore)),
    );
    app.post(
      "/v1/learning/experiments/status",
      ...protectedRoute(createLearningExperimentStatusHandler(config.learningStore)),
    );
    app.post(
      "/v1/learning/experiments/promote",
      ...protectedRoute(createLearningExperimentPromoteHandler(config.learningStore)),
    );
  }

  return app;
}

export interface RunningBroker {
  app: Express;
  server: Server;
  close(): Promise<void>;
}

export async function startBroker(config: BrokerServerConfig): Promise<RunningBroker> {
  const app = buildBrokerApp(config);
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(config.port, config.host, () => resolve(s as Server));
    s.on("error", (err) => reject(err));
  });
  return {
    app,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export interface BrokerEnvConfig {
  host: string;
  port: number;
  enabled: boolean;
  keys: BrokerKeyStore;
}

export function readBrokerEnv(env: NodeJS.ProcessEnv): BrokerEnvConfig {
  const keys = loadBrokerKeysFromEnv(env);
  const host = env.HUGIN_BROKER_HOST?.trim() || "127.0.0.1";
  const port = Number.parseInt(env.HUGIN_BROKER_PORT ?? "3033", 10);
  return {
    host,
    port,
    enabled: Object.keys(keys).length > 0,
    keys,
  };
}
