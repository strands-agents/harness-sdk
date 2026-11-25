from __future__ import annotations

import asyncio
import atexit
import json
import logging
import shlex
import subprocess
import threading
from collections.abc import Sequence
from concurrent.futures import Future
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from opentelemetry import trace
from strands_evals import Experiment
from strands_evals.evaluators import Evaluator
from strands_evals.optimization import InfrastructureError

from .errors import StrandsDevEvalsError
from .imports import import_attribute
from .space import Without

logger = logging.getLogger(__name__)

TEMPORARY_TYPESCRIPT_SUFFIXES = frozenset({".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"})
_SETUP_TIMEOUT_SECONDS = 300.0
_CLOSE_TIMEOUT_SECONDS = 5.0
_MODEL_OBJECT_IGNORES_EFFORT = (
    "the agent's model is a model object, and the harness ignores effort for model objects. Pass the model as an id "
    "string such as bedrock/<model id>, or tune instructions (the default)."
)
_USAGE_ATTRIBUTES = (
    ("inputTokens", "gen_ai.usage.input_tokens"),
    ("outputTokens", "gen_ai.usage.output_tokens"),
    ("totalTokens", "gen_ai.usage.total_tokens"),
    ("cacheReadInputTokens", "gen_ai.usage.cache_read_input_tokens"),
    ("cacheWriteInputTokens", "gen_ai.usage.cache_write_input_tokens"),
)


class TemporaryRunnerGone(RuntimeError):
    pass


class TemporaryTypescriptRunner:
    def __init__(self, command: list[str]) -> None:
        try:
            self._process = subprocess.Popen(
                command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                bufsize=1,
            )
        except OSError as e:
            raise StrandsDevEvalsError(
                f"cannot start the TypeScript runner {command[0]}: {e}. Restart strands dev, then try again."
            ) from e
        self._pending: dict[int, Future[dict[str, Any]]] = {}
        self._lock = threading.Lock()
        self._next_id = 0
        threading.Thread(target=self._read_replies, name="temporary-typescript-runner", daemon=True).start()
        atexit.register(self.close)

    def call(self, message: dict[str, Any]) -> dict[str, Any]:
        return self._request(message)[1].result(timeout=_SETUP_TIMEOUT_SECONDS)

    async def call_async(self, message: dict[str, Any]) -> dict[str, Any]:
        request_id, future = self._request(message)
        try:
            return await asyncio.wrap_future(future)
        except asyncio.CancelledError:
            self._cancel(request_id)
            raise

    def close(self) -> None:
        if self._process.poll() is not None:
            return
        if self._process.stdin is not None:
            with self._lock:
                self._process.stdin.close()
        try:
            self._process.wait(timeout=_CLOSE_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            self._process.kill()

    def _write(self, payload: dict[str, Any]) -> None:
        stdin = self._process.stdin
        if stdin is None or stdin.closed or self._process.poll() is not None:
            raise TemporaryRunnerGone("the TypeScript runner has exited")
        try:
            stdin.write(json.dumps(payload) + "\n")
            stdin.flush()
        except OSError as e:
            raise TemporaryRunnerGone(f"the TypeScript runner stopped reading requests: {e}") from e

    def _request(self, message: dict[str, Any]) -> tuple[int, Future[dict[str, Any]]]:
        future: Future[dict[str, Any]] = Future()
        with self._lock:
            self._next_id += 1
            request_id = self._next_id
            self._pending[request_id] = future
            try:
                self._write({**message, "id": request_id})
            except TemporaryRunnerGone:
                self._pending.pop(request_id)
                raise
        return request_id, future

    def _cancel(self, request_id: int) -> None:
        with self._lock:
            self._pending.pop(request_id, None)
            try:
                self._write({"type": "cancel", "target": request_id})
            except TemporaryRunnerGone:
                logger.debug("request_id=<%s> | the typescript runner exited before the cancel", request_id)

    def _read_replies(self) -> None:
        try:
            for line in self._process.stdout or ():
                self._deliver(line)
        finally:
            self._fail_pending()

    def _deliver(self, line: str) -> None:
        try:
            reply = json.loads(line)
        except ValueError:
            logger.warning("line=<%s> | ignored a typescript runner line that is not json", line.strip()[:200])
            return
        with self._lock:
            future = self._pending.pop(reply.get("id"), None)
        if future is not None and not future.done():
            future.set_result(reply)

    def _fail_pending(self) -> None:
        try:
            code: int | None = self._process.wait(timeout=_CLOSE_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            code = None
        failure = TemporaryRunnerGone(f"the TypeScript runner exited with code {code}")
        with self._lock:
            pending, self._pending = self._pending, {}
        for future in pending.values():
            if not future.done():
                future.set_exception(failure)


class TemporaryTypescriptAgent:
    def __init__(self, runner: TemporaryTypescriptRunner, values: dict[str, Any], model: Any = None) -> None:
        self._runner = runner
        self._values = values
        self._model = values.get("model", model)
        self.messages: list[Any] = []
        self.event_loop_metrics = SimpleNamespace(accumulated_usage={}, cycle_count=0)

    async def invoke_async(self, prompt: Any) -> str:
        try:
            reply = await self._runner.call_async({"type": "run", "values": self._values, "input": prompt})
        except TemporaryRunnerGone as e:
            raise InfrastructureError(str(e)) from e
        self.messages = list(reply.get("messages") or [])
        self.event_loop_metrics = SimpleNamespace(
            accumulated_usage=dict(reply.get("usage") or {}), cycle_count=int(reply.get("cycles") or 0)
        )
        _record_usage(self.event_loop_metrics.accumulated_usage, self._model)
        if reply.get("error") and reply.get("retryable"):
            raise InfrastructureError(f"the TypeScript agent's model call failed: {reply['error']}")
        if reply.get("error"):
            raise RuntimeError(f"the TypeScript agent failed: {reply['error']}")
        return str(reply.get("output") or "")


@dataclass(frozen=True)
class TemporaryTypescriptHarness:
    runner: TemporaryTypescriptRunner
    options: dict[str, Any]
    effort_unavailable_reason: str | None = None

    def build(self, values: dict[str, Any], without: Without | None = None) -> TemporaryTypescriptAgent:
        if values.get("instructions") == "":
            values = {**values, "instructions": None}
        if without:
            values = {**values, "$without": without}
        return TemporaryTypescriptAgent(self.runner, values, self.options.get("model"))

    def builds_with(self, **values: Any) -> bool:
        return bool(self.runner.call({"type": "probe", "values": values}).get("ok"))

    def switch_problem(self, option: str, item: dict[str, Any]) -> str | None:
        return None

    def effort_unavailable(self) -> str | None:
        return self.effort_unavailable_reason

    def effort_baseline(self) -> str:
        return self.options["effort"]


def temporary_refuse_trace_evaluators(experiment_file: str, custom_evaluators: Sequence[str]) -> None:
    evaluators = _experiment_evaluators(experiment_file, custom_evaluators)
    refused = sorted({type(evaluator).__name__ for evaluator in evaluators if _reads_trace(evaluator)})
    if refused:
        raise StrandsDevEvalsError(
            f"{experiment_file} scores with {', '.join(refused)}, which read the agent trace. For now, strands dev "
            "runs a TypeScript agent in its own Node runner, outside strands-evals, so a run records the answer and "
            "the token usage, but no trace. Use evaluators that read only the answer, such as OutputEvaluator or "
            "Contains, then try again."
        )


def load_temporary_typescript_harness(path_text: str, runner_command: str | None) -> TemporaryTypescriptHarness:
    if not runner_command:
        raise StrandsDevEvalsError(
            f"{path_text} is a TypeScript agent; give temporary_typescript_runner, the command that starts its runner"
        )
    path = Path(path_text).expanduser().resolve()
    if not path.is_file():
        raise StrandsDevEvalsError(f"cannot find the TypeScript agent {path_text}. Check the path, then try again.")
    runner = TemporaryTypescriptRunner([*shlex.split(runner_command), str(path), str(Path.cwd())])
    try:
        description = runner.call({"type": "describe"})
    except Exception as e:
        runner.close()
        raise StrandsDevEvalsError(_load_failure(path_text, e)) from e
    if description.get("error"):
        runner.close()
        raise StrandsDevEvalsError(_load_failure(path_text, description["error"]))
    shared = list(description.get("shared_state") or [])
    if shared:
        runner.close()
        raise StrandsDevEvalsError(
            f"{path_text} passes {', '.join(shared)} to createHarness(...), and every run of the agent would share "
            "it. Remove it, then try again."
        )
    return TemporaryTypescriptHarness(runner, _python_options(description), _effort_unavailable(description))


TEMPORARY_TRAJECTORY_EVALUATORS = frozenset(
    {
        "TrajectoryEvaluator",
        "InteractionsEvaluator",
        "ToolCalled",
        "SkillInvoked",
        "SkillSelectionAccuracyEvaluator",
        "SkillInstructionFollowingEvaluator",
    }
)


def _reads_trace(evaluator: Evaluator) -> bool:
    kind = type(evaluator)
    return getattr(kind, "evaluation_level", None) is not None or kind.__name__ in TEMPORARY_TRAJECTORY_EVALUATORS


def _experiment_evaluators(experiment_file: str, custom_evaluators: Sequence[str]) -> list[Evaluator]:
    classes = [_evaluator_class(spec) for spec in custom_evaluators]
    try:
        return list(Experiment.from_file(experiment_file, custom_evaluators=classes).evaluators)
    except Exception as e:
        raise StrandsDevEvalsError(
            f"cannot read the evaluators of {experiment_file} ({type(e).__name__}: {e}). Fix the file, then try again."
        ) from e


def _evaluator_class(spec: str) -> type[Evaluator]:
    target = import_attribute(spec)
    if not isinstance(target, type) or not issubclass(target, Evaluator):
        raise StrandsDevEvalsError(f"the custom evaluator {spec} is a {type(target).__name__}, not an Evaluator class")
    return target


def _load_failure(path_text: str, error: object) -> str:
    return (
        f"{path_text} could not be loaded: {error}. Fix that error, check that strands dev can open this agent, "
        "then try again."
    )


def _record_usage(usage: dict[str, Any], model: Any) -> None:
    attributes: dict[str, Any] = {"gen_ai.operation.name": "chat"}
    attributes.update(
        {attribute: int(usage[field]) for field, attribute in _USAGE_ATTRIBUTES if isinstance(usage.get(field), int)}
    )
    if len(attributes) == 1:
        return
    if isinstance(model, str):
        attributes["gen_ai.request.model"] = model
    with trace.get_tracer(__name__).start_as_current_span("chat", attributes=attributes):
        pass


def _python_options(description: dict[str, Any]) -> dict[str, Any]:
    options: dict[str, Any] = {
        "instructions": description.get("instructions"),
        "effort": description.get("effort") or "auto",
    }
    if description.get("model") and not description.get("model_is_instance"):
        options["model"] = description["model"]
    if description.get("system_prompt"):
        options["system_prompt"] = True
    return options


def _effort_unavailable(description: dict[str, Any]) -> str | None:
    if "effort_unavailable" not in description:
        return _MODEL_OBJECT_IGNORES_EFFORT if description.get("model_is_instance") else None
    reason = description["effort_unavailable"]
    return None if reason is None else str(reason)
