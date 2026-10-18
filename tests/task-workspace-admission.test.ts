import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveContext,
  resolveTaskWorkingDirectory,
  validateTaskWorkspace,
  type WorkspaceRoots,
} from "../src/task-helpers.js";
import { classifyContextSensitivity } from "../src/sensitivity.js";

describe("task workspace admission", () => {
  let tempRoot: string;

  async function setupRoots(): Promise<WorkspaceRoots> {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hugin-workspace-admission-"));
    const reposRoot = path.join(tempRoot, "task-roots");
    const workspace = path.join(reposRoot, "_default");
    const scratch = path.join(reposRoot, "_scratch");
    const files = path.join(reposRoot, "_files");
    const protectedRoot = path.join(tempRoot, "protected");
    await Promise.all([
      fs.mkdir(workspace, { recursive: true }),
      fs.mkdir(scratch, { recursive: true }),
      fs.mkdir(files, { recursive: true }),
      fs.mkdir(protectedRoot, { recursive: true }),
    ]);
    return {
      reposRoot,
      workspace,
      scratch,
      files,
      additionalProtectedRoots: [protectedRoot],
    };
  }

  afterEach(async () => {
    if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("admits a missing workspace destination without creating it and admits a managed repo alias", async () => {
    const roots = await setupRoots();
    const workspaceChild = path.join(roots.workspace!, "newdir", "child");

    const workspaceAdmission = await validateTaskWorkspace(workspaceChild, roots);
    expect(workspaceAdmission).toMatchObject({ ok: true, workingDir: workspaceChild });
    await expect(fs.stat(workspaceChild)).rejects.toMatchObject({ code: "ENOENT" });

    const repoAdmission = await validateTaskWorkspace(
      resolveContext("repo:normal-managed-repo", roots),
      roots,
    );
    const absoluteLegacyAdmission = await validateTaskWorkspace(
      path.join(roots.scratch!, "legacy-absolute"),
      roots,
    );
    expect(repoAdmission).toMatchObject({
      ok: true,
      workingDir: path.join(roots.reposRoot!, "normal-managed-repo"),
    });
    expect(absoluteLegacyAdmission).toMatchObject({
      ok: true,
      workingDir: path.join(roots.scratch!, "legacy-absolute"),
    });
  });

  it("rejects source and symlink aliases into a protected tree", async () => {
    const roots = await setupRoots();
    const protectedRoot = roots.additionalProtectedRoots![0];
    const target = path.join(protectedRoot, "live-checkout");
    const applicationRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
    );
    await fs.mkdir(target);
    await fs.symlink(target, path.join(roots.reposRoot!, "live-alias"));
    await fs.symlink(target, path.join(tempRoot, "outside-alias"));
    await fs.symlink(applicationRoot, path.join(tempRoot, "source-alias"));

    const direct = await validateTaskWorkspace(target, roots);
    const repoAlias = await validateTaskWorkspace(
      resolveContext("repo:live-alias", roots),
      roots,
    );
    const outsideAlias = await validateTaskWorkspace(path.join(tempRoot, "outside-alias", "newdir"), roots);
    const source = await validateTaskWorkspace(applicationRoot, roots);
    const sourceAlias = await validateTaskWorkspace(path.join(tempRoot, "source-alias", "src"), roots);

    expect(direct.ok).toBe(false);
    expect(repoAlias.ok).toBe(false);
    expect(outsideAlias.ok).toBe(false);
    expect(source.ok).toBe(false);
    expect(sourceAlias.ok).toBe(false);
  });

  it("rejects configured roots that contain or sit inside a protected path", async () => {
    const roots = await setupRoots();
    const protectedRoot = roots.additionalProtectedRoots![0];

    const descendantOverlap = await validateTaskWorkspace(
      path.join(protectedRoot, "task-child"),
      { ...roots, reposRoot: path.join(protectedRoot, "task-child") },
    );
    const ancestorOverlap = await validateTaskWorkspace(
      path.dirname(protectedRoot),
      { ...roots, reposRoot: path.dirname(protectedRoot) },
    );

    expect(descendantOverlap.ok).toBe(false);
    expect(ancestorOverlap.ok).toBe(false);
  });

  it("rejects unsafe explicit paths instead of silently mapping them to the default", async () => {
    const roots = {
      reposRoot: "/tmp/hugin-test-repos",
      workspace: "/tmp/hugin-test-workspace",
      scratch: "/tmp/hugin-test-scratch",
      files: "/tmp/hugin-test-files",
    };

    expect(resolveTaskWorkingDirectory(undefined, "/home/magnus/repos/live", roots)).toBe(
      "/home/magnus/repos/live",
    );
    expect((await validateTaskWorkspace("/home/magnus/repos/live", roots)).ok).toBe(false);
    expect(() => resolveTaskWorkingDirectory(undefined, "../../outside", roots)).toThrow();
    expect(() => resolveContext("repo:../../outside", roots)).toThrow();
    expect(resolveContext("project notes", roots)).toBe(roots.workspace);
    expect(resolveTaskWorkingDirectory(undefined, undefined, roots)).toBe(roots.workspace);
  });

  it("keeps admitted files paths private through canonical root identity", async () => {
    const roots = await setupRoots();
    const filePath = path.join(roots.files!, "client", "notes.md");
    const alias = path.join(roots.reposRoot!, "files-alias");
    await fs.symlink(roots.files!, alias);
    const [admission, aliasAdmission] = await Promise.all([
      validateTaskWorkspace(filePath, roots),
      validateTaskWorkspace(path.join(alias, "client", "notes.md"), roots),
    ]);
    expect(admission.ok).toBe(true);
    expect(aliasAdmission.ok).toBe(true);
    if (!admission.ok) return;
    if (!aliasAdmission.ok) return;

    expect(classifyContextSensitivity(undefined, admission.workingDir, admission.roots)).toBe("private");
    expect(classifyContextSensitivity(undefined, aliasAdmission.workingDir, aliasAdmission.roots)).toBe("private");
    expect(classifyContextSensitivity(
      path.join(alias, "client", "notes.md"),
      aliasAdmission.workingDir,
      aliasAdmission.roots,
    )).toBe("private");
    expect(classifyContextSensitivity("files", admission.workingDir, admission.roots)).toBe("private");
    expect(classifyContextSensitivity("scratch", admission.workingDir, admission.roots)).toBe("private");
    expect(classifyContextSensitivity("repo:repo-name", admission.workingDir, admission.roots)).toBe("private");
  });

  it("keeps canonical files sensitivity above scratch, repo, and descriptive labels", async () => {
    const roots = await setupRoots();
    const files = roots.files!;
    const scratch = roots.scratch!;
    const repoFilesAlias = path.join(roots.reposRoot!, "files-alias");
    await fs.symlink(files, repoFilesAlias);
    await fs.rm(scratch, { recursive: true });
    await fs.symlink(files, scratch);

    const repoPath = await validateTaskWorkspace(resolveContext("repo:files-alias", roots), roots);
    const scratchPath = await validateTaskWorkspace(resolveContext("scratch", roots), roots);
    expect(repoPath.ok).toBe(true);
    expect(scratchPath.ok).toBe(true);
    if (!repoPath.ok || !scratchPath.ok) return;
    expect(classifyContextSensitivity("repo:files-alias", repoPath.workingDir, repoPath.roots)).toBe("private");
    expect(classifyContextSensitivity("scratch", scratchPath.workingDir, scratchPath.roots)).toBe("private");

    const nestedWorkspace = path.join(files, "default-workspace");
    await fs.mkdir(nestedWorkspace);
    const workspaceRoots = { ...roots, workspace: nestedWorkspace };
    const workspacePath = await validateTaskWorkspace(resolveContext("project notes", workspaceRoots), workspaceRoots);
    expect(workspacePath.ok).toBe(true);
    if (!workspacePath.ok) return;
    expect(classifyContextSensitivity("project notes", workspacePath.workingDir, workspacePath.roots)).toBe("private");
  });
});
