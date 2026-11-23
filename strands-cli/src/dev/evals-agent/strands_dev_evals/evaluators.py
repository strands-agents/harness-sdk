from __future__ import annotations

import argparse
import inspect
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from strands_evals.evaluators import (
    Cascade,
    CoherenceEvaluator,
    ConcisenessEvaluator,
    Contains,
    CorrectnessEvaluator,
    Equals,
    Evaluator,
    FaithfulnessEvaluator,
    GoalSuccessRateEvaluator,
    HarmfulnessEvaluator,
    HelpfulnessEvaluator,
    InstructionFollowingEvaluator,
    InteractionsEvaluator,
    MultimodalCorrectnessEvaluator,
    MultimodalFaithfulnessEvaluator,
    MultimodalInstructionFollowingEvaluator,
    MultimodalOutputEvaluator,
    MultimodalOverallQualityEvaluator,
    OutputEvaluator,
    RefusalEvaluator,
    ResponseRelevanceEvaluator,
    SkillInstructionFollowingEvaluator,
    SkillInvoked,
    SkillSelectionAccuracyEvaluator,
    StartsWith,
    StateEquals,
    StereotypingEvaluator,
    StructuredOutputSimilarity,
    ToolCalled,
    ToolParameterAccuracyEvaluator,
    ToolSelectionAccuracyEvaluator,
    TrajectoryEvaluator,
    TypedRubricEvaluator,
)
from strands_evals.evaluators.chaos import (
    FailureCommunicationEvaluator,
    PartialCompletionEvaluator,
    RecoveryStrategyEvaluator,
)

AGENT_LANGUAGES: dict[str, str] = {"python": "Python", "typescript": "TypeScript"}
_KEYWORD_PARAMETER_KINDS = (inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.KEYWORD_ONLY)


class EvaluatorKind(str, Enum):
    RUBRIC = "rubric"
    JUDGE = "judge"
    MULTIMODAL = "multimodal"
    CHECK = "check"
    CHAOS = "chaos"


class RunData(str, Enum):
    OUTPUT = "output"
    TRACE = "trace"
    INTERACTIONS = "interactions"
    ENVIRONMENT_STATE = "environment_state"
    INJECTED_FAILURES = "injected_failures"
    IMAGE = "image"
    STRUCTURED_OUTPUT = "structured_output"
    DECISION_MODEL = "decision_model"


@dataclass(frozen=True)
class _DevSupport:
    agents: tuple[str, ...]
    limit: str | None = None


_DEV_SUPPORT: dict[RunData, _DevSupport] = {
    RunData.OUTPUT: _DevSupport(tuple(AGENT_LANGUAGES)),
    RunData.TRACE: _DevSupport(
        ("python",), "It reads the agent trace, and strands dev records a trace only for Python agents."
    ),
    RunData.INTERACTIONS: _DevSupport(
        (), "It reads the messages between agents, and strands dev runs do not record them."
    ),
    RunData.ENVIRONMENT_STATE: _DevSupport(
        (), "It reads the environment state, and strands dev runs do not record it."
    ),
    RunData.INJECTED_FAILURES: _DevSupport(
        (), "It needs a chaos experiment that injects tool failures, and strands dev cannot run one yet."
    ),
    RunData.IMAGE: _DevSupport(
        (), "Its rubric scores what an image in the case shows, and strands dev cases carry text only."
    ),
    RunData.STRUCTURED_OUTPUT: _DevSupport(
        (), "It compares structured output field by field, and strands dev runs record only the text answer."
    ),
    RunData.DECISION_MODEL: _DevSupport(
        (), "It needs a decision model object in Python code, and an experiment file cannot store one."
    ),
}


class SettingType(str, Enum):
    STRING = "string"
    BOOLEAN = "boolean"
    ANY = "any"

    def accepts(self, value: Any) -> bool:
        if self is SettingType.STRING:
            return isinstance(value, str)
        if self is SettingType.BOOLEAN:
            return isinstance(value, bool)
        return True


@dataclass(frozen=True)
class EvaluatorSetting:
    name: str
    description: str
    required: bool = False
    value_type: SettingType = SettingType.STRING

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "type": self.value_type.value,
            "required": self.required,
            "description": self.description,
        }


@dataclass(frozen=True)
class EvaluatorEntry:
    evaluator: type[Evaluator]
    kind: EvaluatorKind
    reads: RunData
    description: str
    settings: tuple[EvaluatorSetting, ...]

    @property
    def name(self) -> str:
        return self.evaluator.get_type_name()

    @property
    def required_settings(self) -> tuple[str, ...]:
        return tuple(setting.name for setting in self.settings if setting.required)

    def dev_limit(self, language: str) -> str | None:
        support = _DEV_SUPPORT[self.reads]
        return None if language in support.agents else support.limit

    def to_dict(self) -> dict[str, Any]:
        support = _DEV_SUPPORT[self.reads]
        return {
            "name": self.name,
            "kind": self.kind.value,
            "description": self.description,
            "reads": self.reads.value,
            "settings": [setting.to_dict() for setting in self.settings],
            "agents": list(support.agents),
            **({"limit": support.limit} if support.limit else {}),
        }


_LABEL = EvaluatorSetting(
    "name", "A label for this evaluator in reports. Set it when the experiment uses the same evaluator two times."
)
_JUDGE_MODEL = EvaluatorSetting(
    "model", "The Bedrock model ID of the judge. Without it, the judge uses the strands-evals default model."
)
_OWN_RUBRIC = EvaluatorSetting("rubric", "Your rubric. Without it, generate writes a rubric from the context.")
_CASE_SENSITIVE = EvaluatorSetting(
    "case_sensitive",
    "Set it to false to ignore uppercase and lowercase. The default is true.",
    value_type=SettingType.BOOLEAN,
)


def _entry(
    evaluator: type[Evaluator],
    kind: EvaluatorKind,
    reads: RunData,
    description: str,
    *settings: EvaluatorSetting,
) -> EvaluatorEntry:
    model = () if kind is EvaluatorKind.CHECK else (_JUDGE_MODEL,)
    label = () if any(setting.name == _LABEL.name for setting in settings) else (_LABEL,)
    return EvaluatorEntry(evaluator, kind, reads, description, (*settings, *model, *label))


_RUBRIC = EvaluatorKind.RUBRIC
_JUDGE = EvaluatorKind.JUDGE
_MULTIMODAL = EvaluatorKind.MULTIMODAL
_CHECK = EvaluatorKind.CHECK
_CHAOS = EvaluatorKind.CHAOS
_OUTPUT = RunData.OUTPUT
_TRACE = RunData.TRACE

EVALUATOR_CATALOG: tuple[EvaluatorEntry, ...] = (
    _entry(OutputEvaluator, _RUBRIC, _OUTPUT, "Scores the final answer against the rubric.", _OWN_RUBRIC),
    _entry(
        TrajectoryEvaluator,
        _RUBRIC,
        _TRACE,
        "Scores the tool calls of the agent and its final answer against the rubric.",
        _OWN_RUBRIC,
    ),
    _entry(
        InteractionsEvaluator,
        _RUBRIC,
        RunData.INTERACTIONS,
        "Scores the messages between agents or components against the rubric.",
        _OWN_RUBRIC,
    ),
    _entry(
        HelpfulnessEvaluator, _JUDGE, _TRACE, "Scores how helpful the answer is from the point of view of the user."
    ),
    _entry(CorrectnessEvaluator, _JUDGE, _TRACE, "Scores the answer as correct, partly correct, or incorrect."),
    _entry(
        FaithfulnessEvaluator,
        _JUDGE,
        _TRACE,
        "Scores how much of the answer conflicts with the conversation and the tool results. "
        "No conflict gets the top score.",
    ),
    _entry(
        ResponseRelevanceEvaluator, _JUDGE, _TRACE, "Scores how well the answer addresses the question of the user."
    ),
    _entry(
        InstructionFollowingEvaluator,
        _JUDGE,
        _TRACE,
        "Passes when the answer obeys every explicit instruction in the prompt.",
    ),
    _entry(
        GoalSuccessRateEvaluator,
        _JUDGE,
        _TRACE,
        "Passes when the agent completes every goal of the user in the conversation.",
    ),
    _entry(ConcisenessEvaluator, _JUDGE, _TRACE, "Scores how short and direct the answer is."),
    _entry(CoherenceEvaluator, _JUDGE, _TRACE, "Scores how logical, consistent, and well organized the answer is."),
    _entry(HarmfulnessEvaluator, _JUDGE, _TRACE, "Passes when the answer contains no harmful content."),
    _entry(StereotypingEvaluator, _JUDGE, _TRACE, "Passes when the answer contains no bias or stereotypes."),
    _entry(
        RefusalEvaluator,
        _JUDGE,
        _TRACE,
        "Passes when the agent refuses the request. Use it for requests that the agent must refuse.",
    ),
    _entry(
        ToolSelectionAccuracyEvaluator,
        _JUDGE,
        _TRACE,
        "Scores whether each tool call is the correct call at that point. A case without tool calls fails.",
    ),
    _entry(
        ToolParameterAccuracyEvaluator,
        _JUDGE,
        _TRACE,
        "Scores whether the parameters of each tool call come from the conversation. A case without tool calls fails.",
    ),
    _entry(
        MultimodalOutputEvaluator,
        _MULTIMODAL,
        _OUTPUT,
        "Scores answers about images or documents against a rubric that you write.",
        EvaluatorSetting("rubric", "The rubric that the judge uses to score each answer.", required=True),
    ),
    _entry(
        MultimodalCorrectnessEvaluator,
        _MULTIMODAL,
        RunData.IMAGE,
        "Scores whether an answer about an image is accurate and complete.",
    ),
    _entry(
        MultimodalFaithfulnessEvaluator,
        _MULTIMODAL,
        RunData.IMAGE,
        "Scores whether an answer about an image uses only what the image shows.",
    ),
    _entry(
        MultimodalInstructionFollowingEvaluator,
        _MULTIMODAL,
        RunData.IMAGE,
        "Scores whether an answer about an image obeys the requirements and limits of the query.",
    ),
    _entry(
        MultimodalOverallQualityEvaluator,
        _MULTIMODAL,
        RunData.IMAGE,
        "Scores an answer about an image for accuracy, instruction following, completeness, and coherence.",
    ),
    _entry(
        Equals,
        _CHECK,
        _OUTPUT,
        "Passes when the answer is exactly the value that you set, or the expected output of the case.",
        EvaluatorSetting("value", "The exact answer. Without it, the check uses the expected output of each case."),
    ),
    _entry(
        Contains,
        _CHECK,
        _OUTPUT,
        "Passes when the answer contains the text that you set.",
        EvaluatorSetting("value", "The text that the answer must contain.", required=True),
        _CASE_SENSITIVE,
    ),
    _entry(
        StartsWith,
        _CHECK,
        _OUTPUT,
        "Passes when the answer starts with the text that you set.",
        EvaluatorSetting("value", "The text that the answer must start with.", required=True),
        _CASE_SENSITIVE,
    ),
    _entry(
        ToolCalled,
        _CHECK,
        _TRACE,
        "Passes when the agent calls the tool that you name.",
        EvaluatorSetting("tool_name", "The name of the tool that the agent must call.", required=True),
    ),
    _entry(
        SkillInvoked,
        _CHECK,
        _TRACE,
        "Passes when the agent loads the skill that you name.",
        EvaluatorSetting("skill_name", "The name of the skill that the agent must load.", required=True),
    ),
    _entry(
        StructuredOutputSimilarity,
        _CHECK,
        RunData.STRUCTURED_OUTPUT,
        "Scores the structured output of the agent against the expected output, field by field.",
        EvaluatorSetting("model_cls", "The dotted path of the Pydantic model that the agent returns.", required=True),
    ),
    _entry(
        SkillSelectionAccuracyEvaluator,
        _JUDGE,
        _TRACE,
        "Scores whether each skill that the agent loads is a good choice for the task.",
    ),
    _entry(
        SkillInstructionFollowingEvaluator,
        _JUDGE,
        _TRACE,
        "Scores how closely the agent follows the steps of each skill that it loads.",
    ),
    _entry(
        StateEquals,
        _CHECK,
        RunData.ENVIRONMENT_STATE,
        "Passes when the named environment state has the expected value.",
        EvaluatorSetting("name", "The name of the environment state. It is also the label in reports.", required=True),
        EvaluatorSetting(
            "value",
            "The expected value. Without it, the check uses the expected state of each case.",
            value_type=SettingType.ANY,
        ),
    ),
    EvaluatorEntry(
        TypedRubricEvaluator,
        _RUBRIC,
        RunData.DECISION_MODEL,
        "Scores the case against typed rubric questions with one call to a decision model.",
        (
            EvaluatorSetting("questions", "The rubric questions, by id.", required=True, value_type=SettingType.ANY),
            EvaluatorSetting(
                "decision_model",
                "The decision model object that answers the rubric.",
                required=True,
                value_type=SettingType.ANY,
            ),
            _LABEL,
        ),
    ),
    EvaluatorEntry(
        Cascade,
        _RUBRIC,
        RunData.DECISION_MODEL,
        "Scores each case with a typed rubric first, and sends each case that the rubric is not sure about "
        "to a fallback evaluator.",
        (
            EvaluatorSetting(
                "fast",
                "The typed rubric evaluator that scores every case first.",
                required=True,
                value_type=SettingType.ANY,
            ),
            EvaluatorSetting(
                "fallback",
                "The evaluator that scores each case that the typed rubric is not sure about.",
                required=True,
                value_type=SettingType.ANY,
            ),
            EvaluatorSetting(
                "escalate_when",
                "The band of rubric probabilities that sends a case to the fallback evaluator.",
                required=True,
                value_type=SettingType.ANY,
            ),
            _LABEL,
        ),
    ),
    _entry(
        FailureCommunicationEvaluator,
        _CHAOS,
        RunData.INJECTED_FAILURES,
        "Scores how clearly the agent tells the user about a tool failure.",
    ),
    _entry(
        PartialCompletionEvaluator,
        _CHAOS,
        RunData.INJECTED_FAILURES,
        "Scores how much of the task the agent completes when tools fail.",
    ),
    _entry(
        RecoveryStrategyEvaluator,
        _CHAOS,
        RunData.INJECTED_FAILURES,
        "Scores whether the agent recovers from a tool failure in a sensible way.",
    ),
)

_ENTRIES: dict[str, EvaluatorEntry] = {entry.name: entry for entry in EVALUATOR_CATALOG}


@dataclass(frozen=True)
class EvaluatorChoice:
    entry: EvaluatorEntry
    settings: Mapping[str, Any] = field(default_factory=dict)

    @property
    def label(self) -> str:
        return str(self.settings.get("name") or self.entry.name)

    @property
    def needs_rubric(self) -> bool:
        return self.entry.kind is EvaluatorKind.RUBRIC and "rubric" not in self.settings

    def build(self, rubric: str | None = None) -> Evaluator:
        written = {} if rubric is None else {"rubric": rubric}
        return self.entry.evaluator(**{**self.settings, **written})


def evaluator_choice(spec: str) -> EvaluatorChoice:
    name, settings = _parse_spec(spec)
    entry = _ENTRIES.get(name)
    if entry is None:
        raise argparse.ArgumentTypeError(
            f"{name} is not a strands-evals evaluator. Use a name from the evaluator list, then try again."
        )
    if entry.kind is EvaluatorKind.CHAOS:
        raise argparse.ArgumentTypeError(
            f"{name} is a chaos evaluator. It needs a chaos experiment that injects tool failures, "
            "and an experiment file cannot store it."
        )
    if entry.reads is RunData.DECISION_MODEL:
        raise argparse.ArgumentTypeError(
            f"{name} needs a decision model object in Python code, and an experiment file cannot store one."
        )
    _check_settings(entry, settings)
    choice = EvaluatorChoice(entry, settings)
    _check_construction(choice)
    return choice


def selection_problem(choices: Sequence[EvaluatorChoice], language: str) -> str | None:
    return _repeated_label_problem(choices) or _language_problem(choices, language)


def main(argv: Sequence[str]) -> int:
    argparse.ArgumentParser(prog="strands-evals evaluators").parse_args(argv)
    print(json.dumps([entry.to_dict() for entry in EVALUATOR_CATALOG], indent=2))
    return 0


def _parse_spec(spec: str) -> tuple[str, dict[str, Any]]:
    text = spec.strip()
    if not text.startswith("{"):
        return text, {}
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as error:
        raise argparse.ArgumentTypeError(f"the evaluator JSON is not valid: {error.msg}.") from error
    name = parsed.get("evaluator_type") if isinstance(parsed, dict) else None
    if not isinstance(name, str) or not name:
        raise argparse.ArgumentTypeError(
            'the evaluator JSON must be an object with an "evaluator_type" name, '
            'for example {"evaluator_type": "ToolCalled", "tool_name": "search"}.'
        )
    return name, {key: value for key, value in parsed.items() if key != "evaluator_type"}


def _check_settings(entry: EvaluatorEntry, settings: Mapping[str, Any]) -> None:
    missing = [name for name in entry.required_settings if name not in settings]
    if missing:
        example = json.dumps({"evaluator_type": entry.name, **{name: "..." for name in entry.required_settings}})
        raise argparse.ArgumentTypeError(f"{entry.name} needs {', '.join(missing)}. Pass it as JSON: {example}")
    accepted = _constructor_settings(entry.evaluator)
    unknown = sorted(set(settings) - accepted)
    if unknown:
        raise argparse.ArgumentTypeError(
            f"{entry.name} does not take {', '.join(unknown)}. It takes {', '.join(sorted(accepted))}."
        )
    wrong = [
        setting
        for setting in entry.settings
        if setting.name in settings and not setting.value_type.accepts(settings[setting.name])
    ]
    if wrong:
        expected = ", ".join(f"{setting.name} must be a {setting.value_type.value}" for setting in wrong)
        raise argparse.ArgumentTypeError(f"{entry.name} has a setting of the wrong type: {expected}.")


def _constructor_settings(evaluator: type[Evaluator]) -> set[str]:
    parameters = list(inspect.signature(evaluator.__init__).parameters.values())[1:]
    return {parameter.name for parameter in parameters if parameter.kind in _KEYWORD_PARAMETER_KINDS}


def _check_construction(choice: EvaluatorChoice) -> None:
    try:
        choice.build(rubric="" if choice.needs_rubric else None)
    except Exception as error:
        raise argparse.ArgumentTypeError(
            f"{choice.entry.name} rejected its settings: {type(error).__name__}: {error}"
        ) from error


def _repeated_label_problem(choices: Sequence[EvaluatorChoice]) -> str | None:
    labels = [choice.label for choice in choices]
    repeated = sorted({label for label in labels if labels.count(label) > 1})
    if not repeated:
        return None
    return (
        f"The experiment has {', '.join(repeated)} more than one time. "
        'Give each copy a different "name" setting, or remove the copies.'
    )


def _language_problem(choices: Sequence[EvaluatorChoice], language: str) -> str | None:
    agent = AGENT_LANGUAGES[language]
    reasons = [
        f"{choice.entry.name} cannot score a {agent} agent in strands dev. {limit}"
        for choice in choices
        if (limit := choice.entry.dev_limit(language))
    ]
    return " ".join(reasons) or None
