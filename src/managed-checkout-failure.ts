import { buildTerminalStatusTags } from "./task-status-tags.js";

export interface MutableTaskStatus {
  content: string;
  tags: string[];
  updated_at: string;
}

interface StatusWriteResult {
  updated_at?: string;
}

export interface TaskStatusClient {
  write(
    namespace: string,
    key: string,
    content: string,
    tags?: string[],
    expectedUpdatedAt?: string,
    classification?: string,
  ): Promise<StatusWriteResult>;
  log(namespace: string, message: string): Promise<unknown>;
}

function applyStatusWrite(
  status: MutableTaskStatus,
  tags: string[],
  result: StatusWriteResult,
): void {
  status.tags = tags;
  if (typeof result.updated_at === "string") {
    status.updated_at = result.updated_at;
  }
}

/** Renew one claimed task with a CAS and carry its new version into finalization. */
export async function renewTaskLease(options: {
  client: TaskStatusClient;
  taskNs: string;
  status: MutableTaskStatus;
  renewedTags: string[];
}): Promise<void> {
  const result = await options.client.write(
    options.taskNs,
    "status",
    options.status.content,
    options.renewedTags,
    options.status.updated_at,
  );
  applyStatusWrite(options.status, options.renewedTags, result);
}

/**
 * Terminalize a managed-checkout refusal without invoking an executor.
 *
 * Lease shutdown is awaited before the terminal CAS so an in-flight renewal
 * cannot advance or overwrite the status concurrently. The caller supplies
 * the single structured-result write with all task-specific metadata.
 */
export async function finalizeManagedCheckoutFailure(options: {
  client: TaskStatusClient;
  taskNs: string;
  status: MutableTaskStatus;
  classification?: string;
  resultContent: string;
  writeStructuredResult: () => Promise<void>;
  logMessage: string;
  stopLeaseRenewal: () => Promise<void>;
}): Promise<void> {
  await options.stopLeaseRenewal();

  const terminalTags = buildTerminalStatusTags("failed", options.status.tags);
  const statusResult = await options.client.write(
    options.taskNs,
    "status",
    options.status.content,
    terminalTags,
    options.status.updated_at,
    options.classification,
  );
  applyStatusWrite(options.status, terminalTags, statusResult);

  await options.client.write(
    options.taskNs,
    "result",
    options.resultContent,
    undefined,
    undefined,
    options.classification,
  );
  try {
    await options.writeStructuredResult();
  } catch (error) {
    console.error(
      `[${options.taskNs}] Failed to write checkout-refusal result-structured after terminal status:`,
      error,
    );
  }
  await options.client.log(options.taskNs, options.logMessage);
}
