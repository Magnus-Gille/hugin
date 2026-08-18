import {
  MuninWriteRejectedError,
  type MuninClient,
} from "./munin-client.js";

export interface ImmutableLearningArtifactWrite {
  namespace: string;
  key: string;
  content: string;
  tags: string[];
  classification?: string;
}

/**
 * Create one immutable learning artifact. A retry may reuse an existing row
 * only when Munin reports the typed create conflict and the stored bytes are
 * exactly identical. Any ambiguous result or divergent collision fails closed.
 */
export async function createImmutableLearningArtifact(
  munin: MuninClient,
  write: ImmutableLearningArtifactWrite,
  options: { allowExactExisting?: boolean; signal?: AbortSignal } = {},
): Promise<"created" | "exact-existing"> {
  try {
    const result = await munin.write(
      write.namespace,
      write.key,
      write.content,
      write.tags,
      undefined,
      write.classification,
      true,
      { signal: options.signal },
    );
    if (result.status !== "created") {
      throw new Error(
        `immutable learning artifact write returned non-created status for ${write.namespace}/${write.key}`,
      );
    }
    return "created";
  } catch (error) {
    if (!(options.allowExactExisting
      && error instanceof MuninWriteRejectedError
      && error.conflictReason === "already_exists")) {
      throw error;
    }
    const existing = await munin.read(write.namespace, write.key, { signal: options.signal });
    if (!existing
      || existing.content !== write.content
      || existing.classification !== write.classification) {
      throw new Error(
        `immutable learning artifact collision differs at ${write.namespace}/${write.key}`,
      );
    }
    return "exact-existing";
  }
}
