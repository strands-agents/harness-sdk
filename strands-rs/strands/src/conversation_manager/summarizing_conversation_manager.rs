//! The summarizing strategy.

use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;

use super::compression::context_compression::{
    DEFAULT_SUMMARIZATION_PROMPT, adjust_split_point_for_tool_pairs, generate_summary,
};
use super::compression::pin_message::{apply_pin_first, partition_pinned};
use super::{ConversationManager, ConversationManagerReduceOptions, ProactiveCompression};
use crate::agent::{InvocationContext, LocalAgent};
use crate::error::{ContextWindowOverflowError, Error, Result};
use crate::models::Model;

const DEFAULT_SUMMARY_RATIO: f64 = 0.3;
const DEFAULT_PRESERVE_RECENT_MESSAGES: usize = 10;

/// Configuration for [`SummarizingConversationManager`] (`SummarizingConversationManagerConfig`).
#[derive(Clone, Default, bon::Builder)]
pub struct SummarizingConversationManagerConfig {
    /// The model that writes summaries: this model > the agent's aux model > the agent's model.
    pub model: Option<Arc<dyn Model>>,
    /// The share of the oldest messages to summarize, clamped to `[0.1, 0.8]`. Defaults to 0.3.
    pub summary_ratio: Option<f64>,
    /// How many recent messages are never summarized. Defaults to 10.
    pub preserve_recent_messages: Option<usize>,
    /// The summarizer's system prompt. Defaults to the built-in summarization prompt.
    #[builder(into)]
    pub summarization_system_prompt: Option<String>,
    /// Proactive compression before model calls. Defaults to disabled.
    #[builder(into)]
    pub proactive_compression: Option<ProactiveCompression>,
    /// How many messages at the start of the conversation to pin permanently; they are never
    /// summarized and move to the front.
    pub pin_first: Option<usize>,
}

impl fmt::Debug for SummarizingConversationManagerConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SummarizingConversationManagerConfig")
            .field("model", &self.model.as_ref().map(|model| model.model_id()))
            .field("summary_ratio", &self.summary_ratio)
            .field("preserve_recent_messages", &self.preserve_recent_messages)
            .field("proactive_compression", &self.proactive_compression)
            .field("pin_first", &self.pin_first)
            .finish_non_exhaustive()
    }
}

/// Summarizes the oldest messages when the context overflows (`SummarizingConversationManager`),
/// replacing them with one user message that holds the summary.
pub struct SummarizingConversationManager {
    model: Option<Arc<dyn Model>>,
    summary_ratio: f64,
    preserve_recent_messages: usize,
    summarization_system_prompt: String,
    pin_first: Option<usize>,
    pin_first_applied: AtomicBool,
    compression_threshold: Option<f64>,
}

impl fmt::Debug for SummarizingConversationManager {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SummarizingConversationManager")
            .field("summary_ratio", &self.summary_ratio)
            .field("preserve_recent_messages", &self.preserve_recent_messages)
            .finish_non_exhaustive()
    }
}

/// A summary that failed during overflow recovery: its message, with the overflow as the source.
#[derive(Debug)]
struct SummarizationFailed {
    error: Error,
    overflow: ContextWindowOverflowError,
}

impl fmt::Display for SummarizationFailed {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.error.fmt(f)
    }
}

impl std::error::Error for SummarizationFailed {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.overflow)
    }
}

impl SummarizingConversationManager {
    /// Creates the manager.
    ///
    /// # Errors
    ///
    /// A proactive compression threshold outside `(0, 1]`.
    pub fn new(config: SummarizingConversationManagerConfig) -> Result<Self> {
        let compression_threshold = config.proactive_compression.unwrap_or_default().threshold()?;
        Ok(Self {
            model: config.model,
            summary_ratio: config.summary_ratio.unwrap_or(DEFAULT_SUMMARY_RATIO).clamp(0.1, 0.8),
            preserve_recent_messages: config
                .preserve_recent_messages
                .unwrap_or(DEFAULT_PRESERVE_RECENT_MESSAGES),
            summarization_system_prompt: config
                .summarization_system_prompt
                .unwrap_or_else(|| DEFAULT_SUMMARIZATION_PROMPT.to_owned()),
            pin_first: config.pin_first,
            pin_first_applied: AtomicBool::new(false),
            compression_threshold,
        })
    }

    /// The share of the oldest messages summarized per reduction, after clamping.
    #[must_use]
    pub fn summary_ratio(&self) -> f64 {
        self.summary_ratio
    }

    async fn summarize_oldest(
        &self,
        agent: &mut LocalAgent,
        model: &Arc<dyn Model>,
        invocation_context: Option<&InvocationContext>,
    ) -> Result<bool> {
        let messages = agent.messages_mut();
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            clippy::cast_precision_loss,
            reason = "a non-negative message count times a ratio in [0.1, 0.8], floored"
        )]
        let by_ratio = ((messages.len() as f64 * self.summary_ratio).floor() as usize).max(1);
        let count = by_ratio.min(messages.len().saturating_sub(self.preserve_recent_messages));
        if count == 0 {
            tracing::warn!(
                "preserve_recent=<{}>, messages=<{}> | insufficient messages for summarization",
                self.preserve_recent_messages,
                messages.len()
            );
            return Ok(false);
        }
        let count = adjust_split_point_for_tool_pairs(messages, count)?;
        if let Some(pin_first) = self.pin_first.filter(|count| *count > 0)
            && !self.pin_first_applied.swap(true, Ordering::Relaxed)
        {
            apply_pin_first(messages, pin_first);
        }
        let (mut preserved, to_summarize) = partition_pinned(messages, 0, count);
        if to_summarize.is_empty() {
            tracing::warn!(
                "messages=<{}> | all messages in summarize range are protected, unable to reduce",
                messages.len()
            );
            return Ok(false);
        }
        let summary = generate_summary(
            &to_summarize,
            model,
            Some(&self.summarization_system_prompt),
            invocation_context,
        )
        .await?;
        preserved.push(summary);
        let messages = agent.messages_mut();
        messages.splice(0..count, preserved);
        Ok(true)
    }
}

#[async_trait]
impl ConversationManager for SummarizingConversationManager {
    fn name(&self) -> &str {
        "strands:summarizing-conversation-manager"
    }

    /// Summarizes with this model > the agent's aux model > the agent's model; the triggering
    /// model is not used. During overflow recovery a failed summary is returned as the error, with
    /// the overflow as its source; during proactive compression it is logged and `false` returned.
    async fn reduce(&self, options: ConversationManagerReduceOptions<'_>) -> Result<bool> {
        let ConversationManagerReduceOptions {
            agent,
            error,
            invocation_context,
            ..
        } = options;
        let model = self.model.clone().unwrap_or_else(|| agent.aux_model().clone());
        let outcome = self.summarize_oldest(agent, &model, invocation_context.as_ref()).await;
        match (outcome, error) {
            (Ok(reduced), _) => Ok(reduced),
            (Err(failure), Some(overflow)) => {
                tracing::error!("error=<{failure}> | summarization failed");
                Err(Error::other(SummarizationFailed {
                    error: failure,
                    overflow,
                }))
            }
            (Err(failure), None) => {
                tracing::warn!("error=<{failure}> | proactive summarization failed, continuing");
                Ok(false)
            }
        }
    }

    fn compression_threshold(&self) -> Option<f64> {
        self.compression_threshold
    }
}
