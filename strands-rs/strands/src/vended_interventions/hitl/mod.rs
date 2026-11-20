//! Human-in-the-loop approval of tool calls.
//!
//! [`HumanInTheLoop`] asks a human before tool calls. By default the agent stops with an
//! interrupt and the caller resumes it with the answer; give it an [`ask`](HumanInTheLoopConfig::ask)
//! callback (or [`HumanInTheLoopAsk::Stdio`]) to ask inline instead.
//!
//! ```
//! use strands::Agent;
//! use strands::testing::MockModel;
//! use strands::vended_interventions::hitl::{HumanInTheLoop, HumanInTheLoopConfig};
//!
//! let hitl = HumanInTheLoop::new(HumanInTheLoopConfig {
//!     allowed_tools: vec!["read_file".into()],
//!     ..Default::default()
//! });
//! let agent = Agent::builder()
//!     .model(MockModel::new())
//!     .interventions([hitl])
//!     .printer(false)
//!     .build()?;
//! # let _ = agent;
//! # Ok::<(), strands::Error>(())
//! ```

mod classifier;

use std::collections::HashSet;
use std::fmt;
use std::future::Future;
use std::io::{self, BufRead, Write};
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use futures::future::BoxFuture;

pub use classifier::{ClassifierConfig, ClassifierResult, HumanInTheLoopClassifier, LlmClassifierConfig};

use crate::error::BoxError;
use crate::hooks::BeforeToolCallEvent;
use crate::interventions::{
    Confirm, Evaluate, InterventionAction, InterventionHandler, InterventionResult, default_evaluate,
};
use crate::models::is_js_whitespace;
use crate::state_store::StateStore;
use crate::types::JsonValue;

/// The app-state key of the tools trusted for the session.
pub const TRUSTED_TOOLS_KEY: &str = "hitl:trustedTools";

crate::callback::callback! {
    /// Collects a human's answer inline. The answer is `None` when there is none, which denies the
    /// call.
    pub struct AskFn(Fn(String) -> BoxFuture<'static, Result<Option<JsonValue>, BoxError>>);
}

/// How a [`HumanInTheLoop`] collects answers inline (`ask`).
#[derive(Clone)]
#[non_exhaustive]
pub enum HumanInTheLoopAsk {
    /// Prompt on the terminal and read a line from stdin (`'stdio'`); concurrent prompts take
    /// turns.
    Stdio,
    /// Ask through your own UI.
    Callback(AskFn),
}

impl HumanInTheLoopAsk {
    /// An inline answer from an async closure.
    ///
    /// ```
    /// use strands::vended_interventions::hitl::HumanInTheLoopAsk;
    ///
    /// let ask = HumanInTheLoopAsk::callback(|prompt: String| async move {
    ///     let _ = prompt;
    ///     Ok(Some(serde_json::json!("yes")))
    /// });
    /// # let _ = ask;
    /// ```
    pub fn callback<F, Fut>(ask: F) -> Self
    where
        F: Fn(String) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Option<JsonValue>, BoxError>> + Send + 'static,
    {
        Self::Callback(AskFn::new(move |prompt| Box::pin(ask(prompt))))
    }
}

impl fmt::Debug for HumanInTheLoopAsk {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Stdio => f.write_str("Stdio"),
            Self::Callback(_) => f.write_str("Callback(..)"),
        }
    }
}

/// Settings of a [`HumanInTheLoop`] (`HumanInTheLoopConfig`).
#[derive(Clone, Default, bon::Builder)]
pub struct HumanInTheLoopConfig {
    /// Tools that run without approval. `*` allows every tool; a `!` prefix makes a tool always
    /// require approval, even under `*` or trust. Listed tools skip the classifier.
    #[builder(default)]
    pub allowed_tools: Vec<String>,
    /// Decides which other tool calls need approval. Unset, all of them do.
    #[builder(into)]
    pub classifier: Option<ClassifierConfig>,
    /// A trust answer (`t`/`trust` by default) approves the call and remembers the tool in app
    /// state for the session. Defaults to `false`. With a classifier, a trusted tool is no longer
    /// classified.
    pub enable_trust: Option<bool>,
    /// Recognizes a trust answer; read only with `enable_trust`. Defaults to `t`/`trust`
    /// (case-insensitive).
    #[builder(into)]
    pub evaluate_trust: Option<Evaluate>,
    /// Recognizes an approval. Defaults to `true` or `y`/`yes` (case-insensitive).
    #[builder(into)]
    pub evaluate: Option<Evaluate>,
    /// Collects answers inline. Unset, the agent stops with an interrupt and resumes with the
    /// answer.
    pub ask: Option<HumanInTheLoopAsk>,
}

impl fmt::Debug for HumanInTheLoopConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HumanInTheLoopConfig")
            .field("allowed_tools", &self.allowed_tools)
            .field("classifier", &self.classifier)
            .field("enable_trust", &self.enable_trust)
            .field("ask", &self.ask)
            .finish_non_exhaustive()
    }
}

fn is_trust_response(response: &JsonValue) -> bool {
    match response {
        JsonValue::String(text) => matches!(text.to_lowercase().trim_matches(is_js_whitespace), "t" | "trust"),
        _ => false,
    }
}

/// App state can be restored from a session, so anything but a list of strings counts as empty.
fn trusted_tools(app_state: &StateStore) -> Vec<String> {
    let Some(JsonValue::Array(values)) = app_state.get_value(TRUSTED_TOOLS_KEY) else {
        return Vec::new();
    };
    values
        .iter()
        .map(|value| value.as_str().map(str::to_owned))
        .collect::<Option<Vec<_>>>()
        .unwrap_or_default()
}

fn trust_tool(app_state: &StateStore, tool_name: &str) {
    let mut trusted = trusted_tools(app_state);
    if trusted.iter().any(|name| name == tool_name) {
        return;
    }
    trusted.push(tool_name.to_owned());
    if let Err(error) = app_state.set(TRUSTED_TOOLS_KEY, trusted) {
        tracing::warn!("tool=<{tool_name}>, error=<{error}> | failed to store the trusted tool");
    }
}

struct Stdio {
    options: &'static str,
    turn: tokio::sync::Mutex<()>,
}

impl Stdio {
    async fn ask(&self, prompt: String) -> Result<Option<JsonValue>, BoxError> {
        let _turn = self.turn.lock().await;
        let line = format!("{prompt} {}: ", self.options);
        let answer = tokio::task::spawn_blocking(move || -> io::Result<Option<String>> {
            let mut stdout = io::stdout().lock();
            stdout.write_all(line.as_bytes())?;
            stdout.flush()?;
            drop(stdout);
            let mut answer = String::new();
            let read = io::stdin().lock().read_line(&mut answer)?;
            Ok((read > 0).then(|| answer.trim_matches(is_js_whitespace).to_owned()))
        })
        .await??;
        Ok(answer.map(JsonValue::String))
    }
}

enum Ask {
    Stdio(Stdio),
    Callback(AskFn),
}

impl Ask {
    async fn ask(&self, prompt: String) -> Result<Option<JsonValue>, BoxError> {
        match self {
            Self::Stdio(stdio) => stdio.ask(prompt).await,
            Self::Callback(ask) => ask(prompt).await,
        }
    }
}

/// Asks a human before tool calls run (`HumanInTheLoop`).
///
/// Which calls need approval, first match wins: a `!tool` entry always does; a tool trusted at
/// runtime (with `enable_trust`) does not; `*` or a listed tool does not; then the classifier
/// decides; without one, every call does. The prompt is
/// `Approve "<tool>"[ — <reason>]?\n  Input: <json>`; with interrupts it is the interrupt's
/// reason, under the interrupt name `strands:human-in-the-loop`.
pub struct HumanInTheLoop {
    allowed_tools: HashSet<String>,
    classifier: Option<Arc<dyn HumanInTheLoopClassifier>>,
    enable_trust: bool,
    evaluate_trust: Option<Evaluate>,
    evaluate: Option<Evaluate>,
    ask: Option<Ask>,
    classified_tool_use_ids: Mutex<HashSet<String>>,
}

impl Default for HumanInTheLoop {
    fn default() -> Self {
        Self::new(HumanInTheLoopConfig::default())
    }
}

impl fmt::Debug for HumanInTheLoop {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HumanInTheLoop")
            .field("allowed_tools", &self.allowed_tools)
            .field("enable_trust", &self.enable_trust)
            .finish_non_exhaustive()
    }
}

/// The name of the handler and of the interrupts it raises.
pub const HUMAN_IN_THE_LOOP_NAME: &str = "strands:human-in-the-loop";

impl HumanInTheLoop {
    /// A handler with these settings.
    #[must_use]
    pub fn new(config: HumanInTheLoopConfig) -> Self {
        let allowed_tools: HashSet<String> = config.allowed_tools.into_iter().collect();
        let classifier = config.classifier.map(ClassifierConfig::resolve);
        if classifier.is_some() && allowed_tools.contains("*") {
            tracing::warn!(
                "classifier has no effect when allowedTools contains \"*\" \u{2014} all tools are already allowed"
            );
        }
        let enable_trust = config.enable_trust.unwrap_or(false);
        let ask = config.ask.map(|ask| match ask {
            HumanInTheLoopAsk::Stdio => Ask::Stdio(Stdio {
                options: if enable_trust { "(y/n/t)" } else { "(y/n)" },
                turn: tokio::sync::Mutex::new(()),
            }),
            HumanInTheLoopAsk::Callback(ask) => Ask::Callback(ask),
        });
        Self {
            allowed_tools,
            classifier,
            enable_trust,
            evaluate_trust: config.evaluate_trust,
            evaluate: config.evaluate,
            ask,
            classified_tool_use_ids: Mutex::new(HashSet::new()),
        }
    }

    fn is_negated(&self, tool_name: &str) -> bool {
        self.allowed_tools.contains(&format!("!{tool_name}"))
    }

    fn is_trust(&self, response: &JsonValue) -> bool {
        match &self.evaluate_trust {
            Some(evaluate) => evaluate(response),
            None => is_trust_response(response),
        }
    }

    fn approves(evaluate: Option<&Evaluate>, response: &JsonValue) -> bool {
        match evaluate {
            Some(evaluate) => evaluate(response),
            None => default_evaluate(response),
        }
    }

    /// Whether the call needs approval, and why.
    async fn requires_approval(&self, event: &BeforeToolCallEvent) -> ClassifierResult {
        let tool_name = event.tool_use().name.as_str();
        if self.is_negated(tool_name) {
            return ClassifierResult::new(true);
        }
        if self.enable_trust
            && trusted_tools(event.agent().app_state())
                .iter()
                .any(|name| name == tool_name)
        {
            return ClassifierResult::new(false);
        }
        if self.allowed_tools.contains("*") || self.allowed_tools.contains(tool_name) {
            return ClassifierResult::new(false);
        }
        let Some(classifier) = &self.classifier else {
            return ClassifierResult::new(true);
        };
        let first_time = self
            .classified_tool_use_ids
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(event.tool_use().tool_use_id.clone());
        if !first_time {
            return ClassifierResult::new(true);
        }
        match classifier.classify(event).await {
            Ok(result) => result,
            Err(error) => {
                tracing::warn!(
                    "tool=<{tool_name}>, error=<{error}> | classifier failed, defaulting to approval required"
                );
                ClassifierResult::new(true)
            }
        }
    }

    /// The confirm action for interrupt/resume mode, whose evaluation also handles trust.
    fn confirm(&self, event: &BeforeToolCallEvent, prompt: String) -> InterventionAction<BeforeToolCallEvent> {
        let tool_name = event.tool_use().name.clone();
        let trust = (!self.is_negated(&tool_name) && self.enable_trust).then(|| self.evaluate_trust.clone());
        let evaluate = self.evaluate.clone();
        let app_state = event.agent().app_state().clone();
        Confirm::new(prompt)
            .with_evaluate(move |response| {
                if let Some(evaluate_trust) = &trust {
                    let trusted = match evaluate_trust {
                        Some(evaluate_trust) => evaluate_trust(response),
                        None => is_trust_response(response),
                    };
                    if trusted {
                        trust_tool(&app_state, &tool_name);
                        return true;
                    }
                }
                Self::approves(evaluate.as_ref(), response)
            })
            .into()
    }
}

#[async_trait]
impl InterventionHandler for HumanInTheLoop {
    fn name(&self) -> &str {
        HUMAN_IN_THE_LOOP_NAME
    }

    async fn before_tool_call(&self, event: &mut BeforeToolCallEvent) -> InterventionResult<BeforeToolCallEvent> {
        let decision = self.requires_approval(event).await;
        if !decision.requires_human_in_the_loop {
            return Ok(InterventionAction::proceed());
        }
        let tool_name = event.tool_use().name.clone();
        let reason = decision
            .reason
            .map(|reason| format!(" \u{2014} {reason}"))
            .unwrap_or_default();
        let input = serde_json::to_string(&event.tool_use().input)?;
        let prompt = format!("Approve \"{tool_name}\"{reason}?\n  Input: {input}");

        let Some(ask) = &self.ask else {
            return Ok(self.confirm(event, prompt));
        };
        // An inline caller cannot resume an interrupt, so a missing answer fails closed.
        let Some(response) = ask.ask(prompt).await? else {
            return Ok(InterventionAction::deny(format!(
                "Tool \"{tool_name}\" denied: approval callback returned no response."
            )));
        };
        if !self.is_negated(&tool_name) && self.enable_trust && self.is_trust(&response) {
            trust_tool(event.agent().app_state(), &tool_name);
            return Ok(InterventionAction::proceed());
        }
        if Self::approves(self.evaluate.as_ref(), &response) {
            return Ok(InterventionAction::proceed());
        }
        Ok(InterventionAction::deny(format!(
            "Tool \"{tool_name}\" denied: the human rejected the call."
        )))
    }
}

#[cfg(test)]
mod tests;
