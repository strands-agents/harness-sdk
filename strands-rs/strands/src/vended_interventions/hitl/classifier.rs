//! Classifiers that decide whether a tool call needs a human.

use std::fmt;
use std::future::Future;
use std::sync::Arc;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;

use crate::agent::{Agent, InvocationContext, InvokeOptions};
use crate::error::BoxError;
use crate::hooks::BeforeToolCallEvent;
use crate::models::Model;
use crate::types::JsonSchema;

/// A classifier's decision (`ClassifierResult`).
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct ClassifierResult {
    /// Whether the tool call needs human approval.
    pub requires_human_in_the_loop: bool,
    /// Why; shown to the human in the approval prompt.
    pub reason: Option<String>,
}

impl ClassifierResult {
    /// A decision without a reason.
    #[must_use]
    pub fn new(requires_human_in_the_loop: bool) -> Self {
        Self {
            requires_human_in_the_loop,
            reason: None,
        }
    }

    /// Sets the reason shown to the human.
    #[must_use]
    pub fn with_reason(mut self, reason: impl Into<String>) -> Self {
        self.reason = Some(reason.into());
        self
    }
}

/// Decides whether a tool call needs human approval (`HumanInTheLoopClassifier`).
///
/// Implemented for async closures over the event:
///
/// ```
/// use strands::hooks::BeforeToolCallEvent;
/// use strands::vended_interventions::hitl::{ClassifierResult, HumanInTheLoopClassifier};
///
/// let classifier = |event: &BeforeToolCallEvent| {
///     let deploy = event.tool_use().name == "deploy";
///     async move { Ok(ClassifierResult::new(deploy).with_reason("deployment requires approval")) }
/// };
/// fn takes(_: impl HumanInTheLoopClassifier) {}
/// takes(classifier);
/// ```
#[async_trait]
pub trait HumanInTheLoopClassifier: Send + Sync + 'static {
    /// Classifies the tool call.
    ///
    /// # Errors
    ///
    /// Any error; the handler then requires approval.
    async fn classify(&self, event: &BeforeToolCallEvent) -> Result<ClassifierResult, BoxError>;
}

#[async_trait]
impl<F, Fut> HumanInTheLoopClassifier for F
where
    F: Fn(&BeforeToolCallEvent) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<ClassifierResult, BoxError>> + Send + 'static,
{
    async fn classify(&self, event: &BeforeToolCallEvent) -> Result<ClassifierResult, BoxError> {
        self(event).await
    }
}

/// Settings of the built-in LLM risk classifier (`LlmClassifierConfig`).
#[derive(Clone, Default, bon::Builder)]
pub struct LlmClassifierConfig {
    /// The risk criteria; defaults to a general-purpose risk prompt.
    #[builder(into)]
    pub system_prompt: Option<String>,
    /// The model that evaluates risk. Resolution order: this model > agent.aux_model >
    /// agent.model.
    pub model: Option<Arc<dyn Model>>,
}

impl fmt::Debug for LlmClassifierConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LlmClassifierConfig")
            .field("system_prompt", &self.system_prompt)
            .field("model", &self.model.as_ref().map(|model| model.model_id()))
            .finish()
    }
}

/// How a [`HumanInTheLoop`](super::HumanInTheLoop) decides which tool calls need a human
/// (`classifier`): the built-in LLM risk classifier or a custom classifier.
#[derive(Clone)]
#[non_exhaustive]
pub enum ClassifierConfig {
    /// The built-in LLM risk classifier.
    Llm(LlmClassifierConfig),
    /// A custom classifier.
    Custom(Arc<dyn HumanInTheLoopClassifier>),
}

impl ClassifierConfig {
    /// The built-in LLM risk classifier with its defaults.
    #[must_use]
    pub fn llm() -> Self {
        Self::Llm(LlmClassifierConfig::default())
    }

    /// A custom classifier, such as an async closure.
    pub fn custom(classifier: impl HumanInTheLoopClassifier) -> Self {
        Self::Custom(Arc::new(classifier))
    }

    pub(crate) fn resolve(self) -> Arc<dyn HumanInTheLoopClassifier> {
        match self {
            Self::Llm(config) => Arc::new(LlmRiskClassifier::new(config)),
            Self::Custom(classifier) => classifier,
        }
    }
}

impl From<LlmClassifierConfig> for ClassifierConfig {
    fn from(config: LlmClassifierConfig) -> Self {
        Self::Llm(config)
    }
}

/// A custom classifier, such as an async closure, so the config builder's `classifier(..)`
/// takes one directly. Wrap an `Arc<dyn HumanInTheLoopClassifier>` in [`ClassifierConfig::Custom`].
impl<C: HumanInTheLoopClassifier> From<C> for ClassifierConfig {
    fn from(classifier: C) -> Self {
        Self::Custom(Arc::new(classifier))
    }
}

impl fmt::Debug for ClassifierConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Llm(config) => f.debug_tuple("Llm").field(config).finish(),
            Self::Custom(_) => f.write_str("Custom(..)"),
        }
    }
}

const RISK_CRITERIA: &str = "## When to require approval

Require approval when the tool call:
- Is destructive or irreversible (deleting data, dropping tables, revoking access)
- Modifies important state in production or shared environments
- Accesses or transmits sensitive data (credentials, PII, financial records)
- Communicates externally (sending emails, posting messages, making payments)
- Has a large blast radius (affecting many records, users, or systems)

## When approval is NOT needed

Do not require approval when the tool call:
- Is read-only AND does not access sensitive data (listing non-sensitive files, querying public data, searching)
- Operates on local or temporary resources
- Has easily reversible effects
- Is scoped to a single non-critical resource

Note: even read-only operations that access credentials, secrets, PII, or financial data still require approval.";

pub(crate) fn default_system_prompt() -> String {
    format!(
        "You are a risk evaluator for an AI agent's tool calls. Your job is to decide whether each tool call requires human approval before executing.

{RISK_CRITERIA}

## Instructions

Evaluate the tool name and its input arguments. Consider what could go wrong if this specific call executes with these specific arguments. When uncertain, require approval.

Keep your reason under 10 words \u{2014} it is shown to a human in a CLI prompt."
    )
}

fn risk_decision_schema() -> JsonSchema {
    json!({
        "type": "object",
        "properties": {
            "requiresApproval": {
                "type": "boolean",
                "description": "Whether this tool call requires human approval before executing"
            },
            "reason": {
                "type": "string",
                "description": "Brief reason (under 10 words) why approval is or is not required"
            }
        },
        "required": ["requiresApproval", "reason"],
        "additionalProperties": false
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RiskDecision {
    requires_approval: bool,
    reason: String,
}

/// The tool call as the risk prompt shows it.
pub(crate) fn format_tool_call(event: &BeforeToolCallEvent) -> String {
    let input = serde_json::to_string_pretty(&event.tool_use().input).unwrap_or_default();
    format!("Tool: {}\nInput: {input}", event.tool_use().name)
}

/// The built-in LLM risk classifier: an inner agent with structured
/// output answers whether the call needs approval.
struct LlmRiskClassifier {
    system_prompt: String,
    model: Option<Arc<dyn Model>>,
}

impl LlmRiskClassifier {
    fn new(config: LlmClassifierConfig) -> Self {
        Self {
            system_prompt: config.system_prompt.unwrap_or_else(default_system_prompt),
            model: config.model,
        }
    }
}

#[async_trait]
impl HumanInTheLoopClassifier for LlmRiskClassifier {
    async fn classify(&self, event: &BeforeToolCallEvent) -> Result<ClassifierResult, BoxError> {
        let model = self.model.clone().unwrap_or_else(|| event.agent().aux_model().clone());
        let mut inner = Agent::builder()
            .model(model)
            .system_prompt(self.system_prompt.clone())
            .structured_output_schema_json(risk_decision_schema())
            .printer(false)
            .build()?;
        let prompt = format!(
            "Should this tool call require human approval?\n\n{}",
            format_tool_call(event)
        );
        let options = InvokeOptions {
            invocation_context: InvocationContext::auxiliary(event.invocation_context()),
            ..Default::default()
        };
        let result = inner.invoke_with(prompt, options).await?;
        let decision: RiskDecision = result.structured_output()?;
        Ok(ClassifierResult::new(decision.requires_approval).with_reason(decision.reason))
    }
}
