"""Guardrail-related type definitions for the SDK.

These types are modeled after the Bedrock API.

- Bedrock docs: https://docs.aws.amazon.com/bedrock/latest/APIReference/API_Types_Amazon_Bedrock_Runtime.html
"""

from typing import Literal

from typing_extensions import TypedDict


class GuardrailConfig(TypedDict, total=False):
    """Configuration for content filtering guardrails.

    Attributes:
        guardrailIdentifier: Unique identifier for the guardrail.
        guardrailVersion: Version of the guardrail to apply.
        streamProcessingMode: Processing mode.
        trace: The trace behavior for the guardrail.
    """

    guardrailIdentifier: str
    guardrailVersion: str
    streamProcessingMode: Literal["sync", "async"] | None
    trace: Literal["enabled", "disabled"]


class Topic(TypedDict):
    """Information about a topic guardrail.

    Attributes:
        action: The action the guardrail should take when it intervenes on a topic.
        name: The name for the guardrail.
        type: The type behavior that the guardrail should perform when the model detects the topic.
    """

    action: Literal["BLOCKED"]
    name: str
    type: Literal["DENY"]


class TopicPolicy(TypedDict):
    """A behavior assessment of a topic policy.

    Attributes:
        topics: The topics in the assessment.
    """

    topics: list[Topic]


class ContentFilter(TypedDict):
    """The content filter for a guardrail.

    Attributes:
        action: Action to take when content is detected.
        confidence: Confidence level of the detection.
        type: The type of content to filter.
    """

    action: Literal["BLOCKED"]
    confidence: Literal["NONE", "LOW", "MEDIUM", "HIGH"]
    type: Literal["INSULTS", "HATE", "SEXUAL", "VIOLENCE", "MISCONDUCT", "PROMPT_ATTACK"]


class ContentPolicy(TypedDict):
    """An assessment of a content policy for a guardrail.

    Attributes:
        filters: List of content filters to apply.
    """

    filters: list[ContentFilter]


class CustomWord(TypedDict):
    """Definition of a custom word to be filtered.

    Attributes:
        action: Action to take when the word is detected.
        match: The word or phrase to match.
    """

    action: Literal["BLOCKED"]
    match: str


class ManagedWord(TypedDict):
    """Definition of a managed word to be filtered.

    Attributes:
        action: Action to take when the word is detected.
        match: The word or phrase to match.
        type: Type of the word.
    """

    action: Literal["BLOCKED"]
    match: str
    type: Literal["PROFANITY"]


class WordPolicy(TypedDict):
    """The word policy assessment.

    Attributes:
        customWords: List of custom words to filter.
        managedWordLists: List of managed word lists to filter.
    """

    customWords: list[CustomWord]
    managedWordLists: list[ManagedWord]


class PIIEntity(TypedDict):
    """Definition of a Personally Identifiable Information (PII) entity to be filtered.

    Attributes:
        action: Action to take when PII is detected.
        match: The specific PII instance to match.
        type: The type of PII to detect.
    """

    action: Literal["ANONYMIZED", "BLOCKED"]
    match: str
    type: Literal[
        "ADDRESS",
        "AGE",
        "AWS_ACCESS_KEY",
        "AWS_SECRET_KEY",
        "CA_HEALTH_NUMBER",
        "CA_SOCIAL_INSURANCE_NUMBER",
        "CREDIT_DEBIT_CARD_CVV",
        "CREDIT_DEBIT_CARD_EXPIRY",
        "CREDIT_DEBIT_CARD_NUMBER",
        "DRIVER_ID",
        "EMAIL",
        "INTERNATIONAL_BANK_ACCOUNT_NUMBER",
        "IP_ADDRESS",
        "LICENSE_PLATE",
        "MAC_ADDRESS",
        "NAME",
        "PASSWORD",
        "PHONE",
        "PIN",
        "SWIFT_CODE",
        "UK_NATIONAL_HEALTH_SERVICE_NUMBER",
        "UK_NATIONAL_INSURANCE_NUMBER",
        "UK_UNIQUE_TAXPAYER_REFERENCE_NUMBER",
        "URL",
        "USERNAME",
        "US_BANK_ACCOUNT_NUMBER",
        "US_BANK_ROUTING_NUMBER",
        "US_INDIVIDUAL_TAX_IDENTIFICATION_NUMBER",
        "US_PASSPORT_NUMBER",
        "US_SOCIAL_SECURITY_NUMBER",
        "VEHICLE_IDENTIFICATION_NUMBER",
    ]


class Regex(TypedDict):
    """Definition of a custom regex pattern for filtering sensitive information.

    Attributes:
        action: Action to take when the pattern is matched.
        match: The regex filter match.
        name: Name of the regex pattern for identification.
        regex: The regex query.
    """

    action: Literal["ANONYMIZED", "BLOCKED"]
    match: str
    name: str
    regex: str


class SensitiveInformationPolicy(TypedDict):
    """Policy defining sensitive information filtering rules.

    Attributes:
        piiEntities: List of Personally Identifiable Information (PII) entities to detect and handle.
        regexes: The regex queries in the assessment.
    """

    piiEntities: list[PIIEntity]
    regexes: list[Regex]


class ContextualGroundingFilter(TypedDict):
    """Filter for ensuring responses are grounded in provided context.

    Attributes:
        action: Action to take when the threshold is not met.
        score: The score generated by contextual grounding filter (range [0, 1]).
        threshold: Threshold used by contextual grounding filter to determine whether the content is grounded or not.
        type: The contextual grounding filter type.
    """

    action: Literal["BLOCKED", "NONE"]
    score: float
    threshold: float
    type: Literal["GROUNDING", "RELEVANCE"]


class ContextualGroundingPolicy(TypedDict):
    """The policy assessment details for the guardrails contextual grounding filter.

    Attributes:
        filters: The filter details for the guardrails contextual grounding filter.
    """

    filters: list[ContextualGroundingFilter]


class GuardrailAssessment(TypedDict):
    """A behavior assessment of the guardrail policies used in a call to the Converse API.

    Attributes:
        contentPolicy: The content policy.
        contextualGroundingPolicy: The contextual grounding policy used for the guardrail assessment.
        sensitiveInformationPolicy: The sensitive information policy.
        topicPolicy: The topic policy.
        wordPolicy: The word policy.
    """

    contentPolicy: ContentPolicy
    contextualGroundingPolicy: ContextualGroundingPolicy
    sensitiveInformationPolicy: SensitiveInformationPolicy
    topicPolicy: TopicPolicy
    wordPolicy: WordPolicy


class GuardrailTrace(TypedDict):
    """Trace information from guardrail processing.

    Attributes:
        inputAssessment: Assessment of input content against guardrail policies, keyed by input identifier.
        modelOutput: The original output from the model before guardrail processing.
        outputAssessments: Assessments of output content against guardrail policies, keyed by output identifier.
    """

    inputAssessment: dict[str, GuardrailAssessment]
    modelOutput: list[str]
    outputAssessments: dict[str, list[GuardrailAssessment]]


class Trace(TypedDict):
    """A Top level guardrail trace object.

    Attributes:
        guardrail: Trace information from guardrail processing.
    """

    guardrail: GuardrailTrace
