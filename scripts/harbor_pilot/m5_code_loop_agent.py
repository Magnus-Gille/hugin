"""Harbor 0.18 external agent that applies an M5 code_loop diff to /app.

The M5 credential remains in the host Harbor process. It is never passed to the
task container. The TypeScript helper reuses Hugin's validated code_loop client
and effective-execution binding before this adapter applies any diff.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any, override

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class M5CodeLoopAgent(BaseAgent):
    SUPPORTS_ATIF = False

    def __init__(
        self,
        logs_dir: Path,
        model_name: str | None = None,
        expected_harness_version: str = "code-loop-pi-2026-07-13-v2",
        wall_s: int | str = 600,
        turns: int | str = 13,
        completion_tokens: int | str = 60_000,
        edit_deadline_turn: int | str | None = None,
        poll_ms: int | str = 5_000,
        result_deadline_s: int | str = 900,
        *args: Any,
        **kwargs: Any,
    ) -> None:
        super().__init__(logs_dir, model_name=model_name, *args, **kwargs)
        if not model_name:
            raise ValueError("M5CodeLoopAgent requires an explicit model_name")
        self.expected_harness_version = expected_harness_version
        self.caps: dict[str, int] = {
            "wall_s": self._bounded_int("wall_s", wall_s, 1, 900),
            "turns": self._bounded_int("turns", turns, 1, 40),
            "completion_tokens": self._bounded_int(
                "completion_tokens", completion_tokens, 1, 120_000
            ),
        }
        if edit_deadline_turn is not None:
            deadline = self._bounded_int(
                "edit_deadline_turn", edit_deadline_turn, 1, self.caps["turns"]
            )
            self.caps["edit_deadline_turn"] = deadline
        self.poll_ms = self._bounded_int("poll_ms", poll_ms, 250, 30_000)
        self.result_deadline_s = self._bounded_int(
            "result_deadline_s", result_deadline_s, 60, 3_600
        )
        self.repo_root = Path(__file__).resolve().parents[2]

    @staticmethod
    def _bounded_int(name: str, raw: int | str, minimum: int, maximum: int) -> int:
        try:
            value = int(raw)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{name} must be an integer") from exc
        if value < minimum or value > maximum:
            raise ValueError(f"{name} must be between {minimum} and {maximum}")
        return value

    @staticmethod
    @override
    def name() -> str:
        return "m5-code-loop-harbor-pilot"

    @override
    def version(self) -> str:
        return "0.1.0-harbor-0.18.0"

    @override
    async def setup(self, environment: BaseEnvironment) -> None:
        return

    @staticmethod
    def _load_control(path: Path) -> dict[str, Any]:
        raw = json.loads(path.read_text())
        task_id = raw.get("task_id")
        protected = raw.get("protected")
        if not isinstance(task_id, str) or not task_id or "/" in task_id or ".." in task_id:
            raise ValueError("invalid Harbor pilot task_id")
        if not isinstance(protected, list) or not all(
            isinstance(item, str) and item for item in protected
        ):
            raise ValueError("invalid Harbor pilot protected paths")
        return {"task_id": task_id, "protected": protected}

    @staticmethod
    def _seed_files(root: Path) -> list[dict[str, str]]:
        files: list[dict[str, str]] = []
        for path in sorted(root.rglob("*")):
            if path.is_symlink():
                raise ValueError(f"seed contains symlink: {path}")
            if not path.is_file():
                continue
            relative = path.relative_to(root).as_posix()
            files.append({"path": relative, "content": path.read_text()})
        if not files:
            raise ValueError("Harbor task seed is empty")
        if len(files) > 64:
            raise ValueError("Harbor task seed exceeds M5's 64-file cap")
        total = sum(len(item["content"].encode()) for item in files)
        if total > 2 * 1024 * 1024:
            raise ValueError("Harbor task seed exceeds M5's 2 MiB cap")
        return files

    def _replay_path(self, task_id: str) -> Path | None:
        replay_dir = os.environ.get("HUGIN_HARBOR_REPLAY_DIR")
        if not replay_dir:
            return None
        root = Path(replay_dir).expanduser().resolve(strict=True)
        raw_candidate = root / f"{task_id}.json"
        if raw_candidate.is_symlink():
            raise ValueError("unsafe Harbor replay path")
        candidate = raw_candidate.resolve(strict=True)
        if candidate.parent != root:
            raise ValueError("unsafe Harbor replay path")
        return candidate

    @staticmethod
    def _redacted_result(
        result: dict[str, Any], apply_return_code: int | None, mode: str
    ) -> dict[str, Any]:
        diff = result.get("diff") if isinstance(result.get("diff"), str) else ""
        check = result.get("check") if isinstance(result.get("check"), dict) else {}
        return {
            "schema_version": 1,
            "mode": mode,
            "status": result.get("status"),
            "work_id": result.get("work_id"),
            "usage": result.get("usage"),
            "execution": result.get("execution"),
            "telemetry": result.get("telemetry"),
            "changed_files": result.get("changed_files"),
            "protected_violations": result.get("protected_violations"),
            "diff_sha256": hashlib.sha256(diff.encode()).hexdigest(),
            "diff_bytes": len(diff.encode()),
            "diff_truncated": result.get("diff_truncated"),
            "apply_return_code": apply_return_code,
            "m5_check": {
                "ran": check.get("ran"),
                "exit_code": check.get("exit_code"),
                "duration_ms": check.get("duration_ms"),
            },
        }

    async def _invoke_helper(
        self,
        request_path: Path,
        result_path: Path,
    ) -> tuple[str, str]:
        helper = self.repo_root / "scripts/harbor_pilot/m5-code-loop-once.ts"
        process = await asyncio.create_subprocess_exec(
            "npx",
            "--no-install",
            "tsx",
            str(helper),
            str(request_path),
            str(result_path),
            cwd=str(self.repo_root),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate()
        if process.returncode != 0:
            detail = stderr.decode(errors="replace")[-2_000:]
            raise RuntimeError(f"M5 code_loop helper failed: {detail}")
        return stdout.decode(errors="replace"), stderr.decode(errors="replace")

    @staticmethod
    async def _apply_diff_on_host(diff: str, seed_dir: Path, patch_path: Path) -> int:
        patch_path.write_text(diff)
        patch_path.chmod(0o600)
        process = await asyncio.create_subprocess_exec(
            "git",
            "apply",
            "--whitespace=nowarn",
            str(patch_path),
            cwd=str(seed_dir),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await process.communicate()
        if process.returncode != 0:
            (patch_path.parent / "apply-error.txt").write_text(
                stderr.decode(errors="replace")[-2_000:]
            )
        return process.returncode

    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="hugin-harbor-agent-") as tmp_raw:
            tmp = Path(tmp_raw)
            control_path = tmp / "control.json"
            await environment.download_file(
                source_path="/app/.harbor-pilot.json",
                target_path=control_path,
            )
            control = self._load_control(control_path)

            seed_dir = tmp / "seed"
            await environment.download_dir_with_exclusions(
                source_dir="/app",
                target_dir=seed_dir,
                exclude=["node_modules", ".git", ".harbor-pilot.json"],
            )
            request: dict[str, Any] = {
                "request": {
                    "instruction": instruction,
                    "files": self._seed_files(seed_dir),
                    "protected": control["protected"],
                    "task_type": "code-edit",
                    "caps": self.caps,
                },
                "expected": {
                    "model": self.model_name,
                    "harnessVersion": self.expected_harness_version,
                    "caps": self.caps,
                },
                "pollMs": self.poll_ms,
                "resultDeadlineS": self.result_deadline_s,
            }
            replay_path = self._replay_path(control["task_id"])
            if replay_path is not None:
                request["replayPath"] = str(replay_path)

            request_path = tmp / "request.json"
            result_path = tmp / "result.json"
            request_path.write_text(json.dumps(request))
            request_path.chmod(0o600)
            await self._invoke_helper(request_path, result_path)
            result = json.loads(result_path.read_text())

            diff = result.get("diff") if isinstance(result.get("diff"), str) else ""
            apply_return_code: int | None = None
            if diff:
                patch_path = tmp / "m5.patch"
                apply_return_code = await self._apply_diff_on_host(
                    diff, seed_dir, patch_path
                )
                if apply_return_code == 0:
                    await environment.upload_dir(seed_dir, "/app")

            mode = "replay" if replay_path is not None else "live"
            redacted = self._redacted_result(result, apply_return_code, mode)
            (self.logs_dir / "m5-result.json").write_text(
                json.dumps(redacted, indent=2, sort_keys=True) + "\n"
            )
            context.n_input_tokens = result.get("usage", {}).get("prompt_tokens")
            context.n_output_tokens = result.get("usage", {}).get("completion_tokens")
            context.cost_usd = 0.0
            context.metadata = redacted
