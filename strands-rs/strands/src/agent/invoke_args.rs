//! Agent invocation input (`InvokeArgs`).

use crate::types::{ContentBlock, InterruptResponse, InterruptResponseContent, Message};

/// The input of an agent invocation (`InvokeArgs`).
///
/// Build it with `.into()` from a string, content blocks, messages or interrupt responses.
///
/// ```
/// use strands::{InterruptResponse, InvokeArgs};
///
/// assert!(matches!(InvokeArgs::from("Hello"), InvokeArgs::Text(_)));
/// let resume: InvokeArgs = vec![InterruptResponse::new("tool:t-1:confirm", "yes")].into();
/// assert!(matches!(resume, InvokeArgs::InterruptResponses(_)));
/// ```
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum InvokeArgs {
    /// User text, sent as one user message with a text block.
    Text(String),
    /// Content blocks, sent as one user message.
    ContentBlocks(Vec<ContentBlock>),
    /// Messages appended to the conversation as given.
    Messages(Vec<Message>),
    /// Responses that resume an interrupted agent.
    InterruptResponses(Vec<InterruptResponseContent>),
}

impl From<&str> for InvokeArgs {
    fn from(text: &str) -> Self {
        Self::Text(text.to_owned())
    }
}

impl From<&String> for InvokeArgs {
    fn from(text: &String) -> Self {
        Self::Text(text.clone())
    }
}

impl From<String> for InvokeArgs {
    fn from(text: String) -> Self {
        Self::Text(text)
    }
}

impl From<Vec<ContentBlock>> for InvokeArgs {
    fn from(blocks: Vec<ContentBlock>) -> Self {
        Self::ContentBlocks(blocks)
    }
}

impl From<Vec<Message>> for InvokeArgs {
    fn from(messages: Vec<Message>) -> Self {
        Self::Messages(messages)
    }
}

impl From<Message> for InvokeArgs {
    fn from(message: Message) -> Self {
        Self::Messages(vec![message])
    }
}

impl From<Vec<InterruptResponseContent>> for InvokeArgs {
    fn from(responses: Vec<InterruptResponseContent>) -> Self {
        Self::InterruptResponses(responses)
    }
}

impl From<Vec<InterruptResponse>> for InvokeArgs {
    fn from(responses: Vec<InterruptResponse>) -> Self {
        Self::InterruptResponses(responses.into_iter().map(InterruptResponseContent::from).collect())
    }
}
