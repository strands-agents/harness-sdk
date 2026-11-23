from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from collections.abc import Sequence
from pathlib import Path
from types import TracebackType
from typing import Any

from strands import Agent
from strands_evals import Case, Experiment
from strands_evals.evaluators import Evaluator
from strands_evals.generators import ExperimentGenerator

from .evaluators import AGENT_LANGUAGES, EvaluatorChoice, evaluator_choice, selection_problem

logger = logging.getLogger(__name__)

_PROG = "strands-evals generate"
_EXIT_FAILED = 3
_ERROR_TEXT_LIMIT = 500
_LOG_FORMAT = "%(levelname)s %(name)s: %(message)s"


def error_text(error: BaseException) -> str:
    text = " ".join(str(error).split())
    summary = f"{type(error).__name__}: {text}" if text else type(error).__name__
    return summary if len(summary) <= _ERROR_TEXT_LIMIT else f"{summary[: _ERROR_TEXT_LIMIT - 1]}…"


class GenerateProgress:
    def __init__(self, path: str) -> None:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        self._stream = target.open("w", encoding="utf-8")
        self._writable = True
        self._total = 0
        self._done = 0
        self._failed = 0

    def __enter__(self) -> GenerateProgress:
        return self

    def __exit__(
        self,
        error_type: type[BaseException] | None,
        error: BaseException | None,
        error_traceback: TracebackType | None,
    ) -> None:
        if isinstance(error, Exception):
            self.failed(error)
        self.close()

    def topics(self) -> None:
        self._write({"event": "topics"})

    def cases(self, total: int) -> None:
        self._total = total
        self._write({"event": "cases", "total": total})

    def case_done(self) -> None:
        self._done += 1
        self._write(self._case_event(ok=True))

    def case_failed(self, error: BaseException) -> None:
        self._failed += 1
        self._write({**self._case_event(ok=False), "error": error_text(error)})

    def rubric(self) -> None:
        self._write({"event": "rubric"})

    def failed(self, error: BaseException) -> None:
        self._write({"event": "failed", "error": error_text(error)})

    def close(self) -> None:
        try:
            self._stream.close()
        except (OSError, ValueError) as error:
            self._stop_writing(error)

    def _case_event(self, ok: bool) -> dict[str, Any]:
        return {"event": "case", "ok": ok, "done": self._done, "failed": self._failed, "total": self._total}

    def _write(self, event: dict[str, Any]) -> None:
        if not self._writable:
            return
        try:
            self._stream.write(f"{json.dumps(event)}\n")
            self._stream.flush()
        except (OSError, ValueError) as error:
            self._stop_writing(error)

    def _stop_writing(self, error: BaseException) -> None:
        if self._writable:
            logger.warning("error=<%s> | stopped writing the progress file", error_text(error))
        self._writable = False


class ProgressGenerator(ExperimentGenerator[str, str]):
    def __init__(self, progress: GenerateProgress, **options: Any) -> None:
        super().__init__(**options)
        self._progress = progress

    async def _prepare_generation_prompts(
        self, base_prompt: str, num_cases: int, num_topics: int | None = None
    ) -> list[tuple[str, int]]:
        if num_topics is not None:
            self._progress.topics()
        prompt_specs = await super()._prepare_generation_prompts(base_prompt, num_cases, num_topics)
        self._progress.cases(sum(count for _prompt, count in prompt_specs))
        return prompt_specs

    async def _case_worker(
        self,
        queue: asyncio.Queue,
        prompt: str,
        message_history: list | None,
        results: list,
        errors: list[Exception],
    ) -> None:
        try:
            case_generator = Agent(
                model=self.model,
                system_prompt=self.case_system_prompt,
                callback_handler=None,
                messages=message_history if message_history else [],
            )
        except Exception as error:
            logger.warning("the case generator agent could not start", exc_info=True)
            self._fail_queued_cases(queue, error)
            errors.append(error)
            return

        while True:
            try:
                difficulty = queue.get_nowait()
            except asyncio.QueueEmpty:
                break

            try:
                full_prompt = prompt
                if difficulty is not None:
                    full_prompt += f" Ensure that the test case has a difficulty level of {difficulty}."
                generated = await case_generator.structured_output_async(self._Case, full_prompt)
                results.append(Case(**generated.model_dump()))
                self._progress.case_done()
            except Exception as error:
                logger.warning("difficulty=<%s> | case generation failed", difficulty, exc_info=True)
                self._progress.case_failed(error)
                errors.append(error)
            finally:
                queue.task_done()

    def _fail_queued_cases(self, queue: asyncio.Queue, error: BaseException) -> None:
        while True:
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                return
            self._progress.case_failed(error)
            queue.task_done()

    async def construct_evaluator_async(
        self, prompt: str, evaluator: Evaluator, message_history: list | None = None
    ) -> Evaluator:
        self._progress.rubric()
        return await super().construct_evaluator_async(
            prompt=prompt, evaluator=evaluator, message_history=message_history
        )


def main(argv: Sequence[str]) -> int:
    logging.basicConfig(level=logging.WARNING, format=_LOG_FORMAT)
    args = _arguments(argv)
    try:
        experiment = _generate(args)
    except Exception as error:
        logger.warning("generation failed", exc_info=True)
        print(f"{_PROG}: error: {error_text(error)}", file=sys.stderr)
        return _EXIT_FAILED
    print(f"generated {len(experiment.cases)} case(s), {len(experiment.evaluators)} evaluator(s)", file=sys.stderr)
    return 0


def _arguments(argv: Sequence[str]) -> argparse.Namespace:
    parser = _parser()
    args = parser.parse_args(argv)
    problem = selection_problem(args.evaluator, args.agent_language)
    if problem:
        parser.error(problem)
    return args


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog=_PROG)
    parser.add_argument("--context", required=True)
    parser.add_argument("--task-description", default="")
    parser.add_argument("--num-cases", type=int, default=5)
    parser.add_argument("--num-topics", type=int)
    parser.add_argument("--evaluator", type=evaluator_choice, action="append", default=[])
    parser.add_argument("--agent-language", choices=sorted(AGENT_LANGUAGES), required=True)
    parser.add_argument("--model")
    parser.add_argument("--max-parallel-num-cases", type=_positive_count)
    parser.add_argument("--no-expected-output", dest="include_expected_output", action="store_false")
    parser.add_argument("--expected-trajectory", dest="include_expected_trajectory", action="store_true")
    parser.add_argument("--expected-interactions", dest="include_expected_interactions", action="store_true")
    parser.add_argument("--metadata", dest="include_metadata", action="store_true")
    parser.add_argument("--progress", required=True)
    parser.add_argument("--output", required=True)
    return parser


def _positive_count(raw: str) -> int:
    try:
        value = int(raw)
    except ValueError as error:
        raise argparse.ArgumentTypeError(f"expected a whole number, got '{raw}'") from error
    if value < 1:
        raise argparse.ArgumentTypeError(f"expected a number of at least 1, got {value}")
    return value


def _generator_options(args: argparse.Namespace) -> dict[str, Any]:
    parallel = args.max_parallel_num_cases
    return {
        "input_type": str,
        "output_type": str,
        "model": args.model,
        "include_expected_output": args.include_expected_output,
        "include_expected_trajectory": args.include_expected_trajectory,
        "include_expected_interactions": args.include_expected_interactions,
        "include_metadata": args.include_metadata,
        **({} if parallel is None else {"max_parallel_num_cases": parallel}),
    }


def _generate(args: argparse.Namespace) -> Experiment:
    with GenerateProgress(args.progress) as progress:
        generator = ProgressGenerator(progress, **_generator_options(args))
        experiment = asyncio.run(_from_context(args, generator))
        experiment.to_file(args.output)
    return experiment


async def _from_context(args: argparse.Namespace, generator: ExperimentGenerator[str, str]) -> Experiment:
    experiment = await generator.from_context_async(
        context=args.context,
        task_description=args.task_description,
        num_cases=args.num_cases,
        num_topics=args.num_topics,
    )
    choices: list[EvaluatorChoice] = args.evaluator
    if not choices:
        return experiment
    rubric_prompt = (
        f"Create a rubric with the following context: {args.context} for this task: {args.task_description} "
    )
    evaluators = await asyncio.gather(*(_evaluator(generator, choice, rubric_prompt) for choice in choices))
    return Experiment(cases=experiment.cases, evaluators=list(evaluators))


async def _evaluator(
    generator: ExperimentGenerator[str, str], choice: EvaluatorChoice, rubric_prompt: str
) -> Evaluator:
    if not choice.needs_rubric:
        return choice.build()
    written = await generator.construct_evaluator_async(prompt=rubric_prompt, evaluator=choice.entry.evaluator)
    return choice.build(rubric=written.rubric)
