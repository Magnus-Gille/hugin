import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startDispatcher } from "./index.js";

export function shouldStartDispatcherFromMain(
  importMetaUrl: string,
  argv1: string | undefined,
): boolean {
  if (!argv1?.trim()) return false;
  return pathToFileURL(resolve(argv1)).href === importMetaUrl;
}

if (shouldStartDispatcherFromMain(import.meta.url, process.argv[1])) {
  startDispatcher();
}
