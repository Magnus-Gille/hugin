/** Return task metadata only; `### Prompt` and everything after it is untrusted prose. */
export function taskMetadataPrefix(content: string): string {
  const promptHeader = /^###\s*Prompt\s*$/im.exec(content);
  return promptHeader ? content.slice(0, promptHeader.index) : content;
}

/** Parse the dispatcher `Model` field without allowing prompt text to steer routing. */
export function parseTaskModelField(content: string): string | undefined {
  return taskMetadataPrefix(content).match(
    /^[ \t]*(?:-[ \t]*)?\*\*Model:\*\*[ \t]*(.+)$/im,
  )?.[1]?.trim() || undefined;
}
