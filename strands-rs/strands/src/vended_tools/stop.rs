//! The `stop` tool: ends the agent loop gracefully.
//!
//! The tool calls the agent's `cancel` with `after_current_tools`, so the rest of the tool batch
//! still runs, then the loop ends with [`StopReason::Cancelled`](crate::StopReason::Cancelled) and
//! the message as the final assistant message. The model sees the same message as the result.

use serde_json::json;

use super::input::InputReader;
use crate::cancel::CancelOptions;
use crate::error::{Error, Result};
use crate::tools::{FunctionTool, ToolError};
use crate::types::{JsonSchema, JsonValue};

/// The final assistant message when the model gives none (`DEFAULT_STOP_MESSAGE`).
pub const DEFAULT_STOP_MESSAGE: &str = "Agent loop stopped.";

/// The description of the `stop` tool shown to the model (`DEFAULT_STOP_DESCRIPTION`).
pub const DEFAULT_STOP_DESCRIPTION: &str = concat!(
    "Gracefully ends the agent loop when the task is complete. ",
    "Call this tool once with an optional final message when no further work is needed. ",
    "This is a cooperative stop, not an abort: any tools already requested in this turn still run."
);

/// The default cap on `message`, in characters (`DEFAULT_MAX_STOP_MESSAGE_LENGTH`).
pub const DEFAULT_MAX_STOP_MESSAGE_LENGTH: usize = 4096;

/// Options for [`make_stop`] (`MakeStopOptions`).
#[derive(Debug, Clone, Default, bon::Builder)]
#[builder(on(String, into))]
pub struct MakeStopOptions {
    /// The tool name; `stop` when absent.
    pub name: Option<String>,
    /// The tool description; [`DEFAULT_STOP_DESCRIPTION`] when absent.
    pub description: Option<String>,
    /// The longest `message` accepted, in characters (UTF-16 code units);
    /// [`DEFAULT_MAX_STOP_MESSAGE_LENGTH`] when absent.
    pub max_message_length: Option<usize>,
}

fn input_schema(max_message_length: usize) -> JsonSchema {
    json!({
        "type": "object",
        "properties": {
            "message": {
                "description": "Optional final message summarizing why the loop is ending. Appears as the loop's last assistant turn.",
                "anyOf": [{"type": "string", "maxLength": max_message_length}, {"type": "null"}]
            }
        },
        "additionalProperties": false
    })
}

/// The default `stop` tool (`stop`).
#[must_use]
pub fn stop() -> FunctionTool {
    build(
        "stop".to_owned(),
        DEFAULT_STOP_DESCRIPTION.to_owned(),
        DEFAULT_MAX_STOP_MESSAGE_LENGTH,
    )
}

/// Creates a stop tool. An absent, `null` or empty `message` becomes
/// [`DEFAULT_STOP_MESSAGE`], so the loop always ends with a final message.
///
/// ```
/// use strands::vended_tools::stop::{MakeStopOptions, make_stop};
///
/// let finish = make_stop(MakeStopOptions::builder().name("finish").build())?;
/// assert_eq!(strands::Tool::name(&finish), "finish");
/// # Ok::<(), strands::Error>(())
/// ```
///
/// # Errors
///
/// When `max_message_length` is 0.
pub fn make_stop(options: MakeStopOptions) -> Result<FunctionTool> {
    let max_message_length = options.max_message_length.unwrap_or(DEFAULT_MAX_STOP_MESSAGE_LENGTH);
    if max_message_length == 0 {
        return Err(Error::other("maxMessageLength must be a positive integer, got 0"));
    }
    Ok(build(
        options.name.unwrap_or_else(|| "stop".to_owned()),
        options
            .description
            .unwrap_or_else(|| DEFAULT_STOP_DESCRIPTION.to_owned()),
        max_message_length,
    ))
}

fn build(name: String, description: String, max_message_length: usize) -> FunctionTool {
    FunctionTool::builder(name, description)
        .input_schema(input_schema(max_message_length))
        .callback(move |input, context| {
            let result = parse(&input, max_message_length).map(|message| {
                context.agent().cancel(CancelOptions {
                    message: Some(message.clone()),
                    after_current_tools: true,
                    ..CancelOptions::default()
                });
                JsonValue::String(message)
            });
            async move { result }
        })
}

fn parse(input: &JsonValue, max_message_length: usize) -> std::result::Result<String, ToolError> {
    let mut reader = InputReader::new(input);
    let message = reader.nullable_string("message");
    if message.is_some_and(|message| message.encode_utf16().count() > max_message_length) {
        reader.issue(
            "message",
            format!("`message` length exceeds the maximum of {max_message_length} characters"),
        );
    }
    reader.finish()?;
    Ok(message
        .filter(|message| !message.is_empty())
        .unwrap_or(DEFAULT_STOP_MESSAGE)
        .to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Agent;
    use crate::agent::ToolAgent;
    use crate::testing::{MockModel, MockTurn};
    use crate::tools::Tool;
    use crate::types::{ContentBlock, StopReason, ToolUseBlock};
    use crate::vended_tools::test_support::{agent, error_text, ok_text};

    fn assert_cancelled_with(agent: &ToolAgent, message: &str) {
        let signal = agent.cancel_signal();
        assert!(signal.is_deferred());
        assert!(!signal.is_cancelled());
        assert_eq!(signal.reason().as_deref(), Some(message));
    }

    #[tokio::test]
    async fn ends_the_loop_after_the_batch_with_the_message_as_the_final_assistant_message() {
        let model = MockModel::new()
            .with_turn(MockTurn::content([ContentBlock::ToolUse(ToolUseBlock::new(
                "stop",
                "t1",
                json!({"message": "All done"}),
            ))]))
            .with_turn("unreachable");
        let mut agent = Agent::builder()
            .model(model.clone())
            .tools([stop()])
            .printer(false)
            .build()
            .unwrap();
        let result = agent.invoke("Go").await.unwrap();
        assert_eq!(result.stop_reason(), StopReason::Cancelled);
        assert_eq!(result.last_message().content, vec![ContentBlock::text("All done")]);
        assert_eq!(agent.messages().last(), Some(result.last_message()));
        assert_eq!(model.call_count(), 1);
    }

    #[tokio::test]
    async fn returns_the_provided_message_verbatim() {
        assert_eq!(
            ok_text(&stop(), json!({"message": "all done"}), &agent()).await,
            "all done"
        );
    }

    #[tokio::test]
    async fn returns_the_default_message_when_none_is_provided() {
        assert_eq!(ok_text(&stop(), json!({}), &agent()).await, DEFAULT_STOP_MESSAGE);
    }

    #[tokio::test]
    async fn defers_the_cancellation_so_sibling_tools_in_the_batch_still_run() {
        let agent = agent();
        ok_text(&stop(), json!({"message": "finished"}), &agent).await;
        assert_cancelled_with(&agent, "finished");
    }

    #[tokio::test]
    async fn cancels_with_the_default_message_when_none_is_provided() {
        let agent = agent();
        ok_text(&stop(), json!({}), &agent).await;
        assert_cancelled_with(&agent, DEFAULT_STOP_MESSAGE);
    }

    #[tokio::test]
    async fn falls_back_to_the_default_when_message_is_an_empty_string_so_the_loop_still_has_a_final_message() {
        let agent = agent();
        assert_eq!(
            ok_text(&stop(), json!({"message": ""}), &agent).await,
            DEFAULT_STOP_MESSAGE
        );
        assert_cancelled_with(&agent, DEFAULT_STOP_MESSAGE);
    }

    #[tokio::test]
    async fn falls_back_to_the_default_when_message_is_null_so_providers_that_serialize_omitted_fields_as_null_still_halt()
     {
        let agent = agent();
        assert_eq!(
            ok_text(&stop(), json!({"message": null}), &agent).await,
            DEFAULT_STOP_MESSAGE
        );
        assert_cancelled_with(&agent, DEFAULT_STOP_MESSAGE);
    }

    #[tokio::test]
    async fn rejects_an_oversized_message() {
        let oversized = "x".repeat(DEFAULT_MAX_STOP_MESSAGE_LENGTH + 1);
        let message = error_text(&stop(), json!({"message": oversized}), &agent()).await;
        assert!(message.contains("maximum"), "{message}");
    }

    #[tokio::test]
    async fn accepts_a_message_at_the_length_cap() {
        let at_cap = "x".repeat(DEFAULT_MAX_STOP_MESSAGE_LENGTH);
        assert_eq!(ok_text(&stop(), json!({"message": at_cap}), &agent()).await, at_cap);
    }

    #[tokio::test]
    async fn rejects_a_non_string_message() {
        error_text(&stop(), json!({"message": 123}), &agent()).await;
    }

    #[tokio::test]
    async fn does_not_cancel_the_agent_when_validation_fails() {
        let agent = agent();
        let oversized = "x".repeat(DEFAULT_MAX_STOP_MESSAGE_LENGTH + 1);
        error_text(&stop(), json!({"message": oversized}), &agent).await;
        assert!(!agent.cancel_signal().is_deferred());
    }

    #[tokio::test]
    async fn relaxes_the_cap_when_max_message_length_is_configured() {
        let big = make_stop(MakeStopOptions::builder().max_message_length(10_000).build()).unwrap();
        let message = "x".repeat(8000);
        assert_eq!(ok_text(&big, json!({"message": message}), &agent()).await, message);
    }

    #[tokio::test]
    async fn still_enforces_the_configured_cap_when_it_is_exceeded() {
        let big = make_stop(MakeStopOptions::builder().max_message_length(10_000).build()).unwrap();
        let message = error_text(&big, json!({"message": "x".repeat(10_001)}), &agent()).await;
        assert!(message.contains("maximum of 10000"), "{message}");
    }

    #[test]
    fn rejects_a_non_positive_max_message_length_at_factory_time() {
        let error = make_stop(MakeStopOptions::builder().max_message_length(0).build()).unwrap_err();
        assert!(error.to_string().contains("positive integer"));
    }

    #[test]
    fn supports_a_custom_name() {
        assert_eq!(
            make_stop(MakeStopOptions::builder().name("finish").build())
                .unwrap()
                .name(),
            "finish"
        );
    }

    #[test]
    fn supports_a_custom_description() {
        let custom = make_stop(MakeStopOptions::builder().description("custom desc").build()).unwrap();
        assert_eq!(custom.description(), "custom desc");
    }

    #[test]
    fn exposes_message_as_an_optional_property_in_the_tool_spec() {
        let schema = stop().tool_spec().input_schema.unwrap();
        assert!(schema["properties"].get("message").is_some());
        assert!(schema.get("required").is_none());
    }
}
