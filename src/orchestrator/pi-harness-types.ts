export type PiHarnessPermissionProfile = "read-only" | "trusted-code";

export interface WorkerWorktreeBinding {
  /** Exact absolute selected worktree path on the Pi. */
  cwd: string;
  /** Immutable ancestry floor the executor must verify immediately before launch. */
  expectedRevision: string;
  /** Exact task branch identity selected for this task. */
  branchName: string;
  /** Canonical managed repos root used by the dispatcher checkout gate. */
  managedRoot: string;
}
