//! The `handoff_to_user` tool: pauses the agent loop with an interrupt that surfaces a message to
//! the user; on resume the user's reply is the tool result.

use serde_json::json;

use super::input::InputReader;
use crate::tools::{FunctionTool, ToolError};
use crate::types::{InterruptParams, JsonSchema, JsonValue};

/// The name of the interrupt the tool raises (`HANDOFF_INTERRUPT_NAME`), the same whatever the
/// tool is called, so callers can match handoffs in
/// [`AgentResult::interrupts`](crate::AgentResult::interrupts).
pub const HANDOFF_INTERRUPT_NAME: &str = "strands:handoff-to-user";

/// The description of the `handoff_to_user` tool shown to the model
/// (`DEFAULT_HANDOFF_TO_USER_DESCRIPTION`).
pub(crate) const DEFAULT_HANDOFF_TO_USER_DESCRIPTION: &str = concat!(
    "Ask the user a question and wait for their answer. Use it only when you cannot proceed ",
    "without confirmation, approval, or information that only the user has. Do not call it to ",
    "deliver a final answer or to report progress. The user's reply is returned as the tool result."
);

/// Options for [`make_handoff_to_user`] (`MakeHandoffToUserOptions`).
#[derive(Debug, Clone, Default, bon::Builder)]
#[builder(on(String, into))]
pub struct MakeHandoffToUserOptions {
    /// The tool name; `handoff_to_user` when absent. The interrupt name stays
    /// [`HANDOFF_INTERRUPT_NAME`].
    pub name: Option<String>,
    /// The tool description; the default handoff description when absent.
    pub description: Option<String>,
}

fn input_schema() -> JsonSchema {
    json!({
        "type": "object",
        "properties": {
            "message": {"type": "string", "description": "The message to surface to the user."}
        },
        "required": ["message"],
        "additionalProperties": false
    })
}

/// The default `handoff_to_user` tool.
#[must_use]
pub fn handoff_to_user() -> FunctionTool {
    make_handoff_to_user(MakeHandoffToUserOptions::default())
}

/// Creates a handoff tool. The first call raises an interrupt named
/// [`HANDOFF_INTERRUPT_NAME`] whose reason is `message`; once answered, the reply is the result.
///
/// ```
/// use strands::vended_tools::handoff_to_user::{MakeHandoffToUserOptions, make_handoff_to_user};
///
/// let ask_user = make_handoff_to_user(MakeHandoffToUserOptions::builder().name("ask_user").build());
/// let agent = strands::Agent::builder().tools([ask_user]).printer(false).build()?;
/// assert!(agent.tool_registry().get("ask_user").is_some());
/// # Ok::<(), strands::Error>(())
/// ```
#[must_use]
pub fn make_handoff_to_user(options: MakeHandoffToUserOptions) -> FunctionTool {
    let name = options.name.unwrap_or_else(|| "handoff_to_user".to_owned());
    let description = options
        .description
        .unwrap_or_else(|| DEFAULT_HANDOFF_TO_USER_DESCRIPTION.to_owned());
    FunctionTool::builder(name, description)
        .input_schema(input_schema())
        .callback(|input, context| {
            let result = parse(&input).and_then(|message| {
                let params = InterruptParams::new(HANDOFF_INTERRUPT_NAME).with_reason(message);
                Ok(context.interrupt(params)?)
            });
            async move { result }
        })
}

fn parse(input: &JsonValue) -> Result<String, ToolError> {
    let mut reader = InputReader::new(input);
    let message = reader.string("message");
    if message.is_some_and(|message| message.trim().is_empty()) {
        reader.issue("message", "message must not be empty");
    }
    reader.finish()?;
    Ok(message.unwrap_or_default().to_owned())
}

#[cfg(test)]
mod tests;
