//! How tool references reach a model: as references a native provider sends, as text naming the
//! loaded tool's parameters, or as the loaded schema for a token count.

use std::collections::{HashMap, HashSet};

use crate::types::{ContentBlock, JsonBlock, Message, TextBlock, ToolResultBlock, ToolResultContent, ToolSpec};

/// Sends the tool references in each tool result as text, unless every block of the result is a
/// reference to a tool the request lists and keeps as a reference (`kept_references`). The Claude
/// API rejects a tool result that mixes tool references with other content, and a reference to a
/// tool its request doesn't list. The text gives the parameters of the request's tool with the
/// reference's name (`withToolReferenceText`).
pub(crate) fn with_tool_reference_text(
    messages: Vec<Message>,
    tool_specs: &[ToolSpec],
    kept_references: &HashSet<String>,
) -> Vec<Message> {
    replace_references(messages, tool_specs, kept_references, |name, spec| {
        ToolResultContent::Text(TextBlock::new(reference_text(name, spec)))
    })
}

/// Puts the input schema each tool reference brings into the model's context in its place, as
/// JSON, so a count of the request measures a loaded schema the way it measures a tool spec
/// (`withToolReferenceSchemas`).
pub(crate) fn with_tool_reference_schemas(messages: Vec<Message>, tool_specs: &[ToolSpec]) -> Vec<Message> {
    replace_references(messages, tool_specs, &HashSet::new(), |name, spec| match spec {
        Some(spec) => ToolResultContent::Json(JsonBlock::new(input_schema(spec))),
        None => ToolResultContent::Text(TextBlock::new(reference_text(name, None))),
    })
}

/// Whether any tool result in the messages holds a tool reference (`hasToolReferences`).
pub(crate) fn has_tool_references(messages: &[Message]) -> bool {
    messages
        .iter()
        .any(|message| message.content.iter().any(has_tool_reference))
}

/// Whether a tool result holds a tool reference, as a `load_tools` result and the answer to a call
/// made before its tool's load do. Such a result is what keeps a loaded tool's schema in the
/// model's context (`holdsToolReference`).
pub(crate) fn holds_tool_reference(block: &ToolResultBlock) -> bool {
    block
        .content
        .iter()
        .any(|content| matches!(content, ToolResultContent::ToolReference(_)))
}

fn has_tool_reference(block: &ContentBlock) -> bool {
    matches!(block, ContentBlock::ToolResult(result) if holds_tool_reference(result))
}

fn input_schema(spec: &ToolSpec) -> serde_json::Value {
    spec.input_schema
        .clone()
        .unwrap_or_else(|| serde_json::Value::Object(serde_json::Map::new()))
}

fn reference_text(name: &str, spec: Option<&ToolSpec>) -> String {
    match spec {
        Some(spec) => format!("{name} parameters: {}", input_schema(spec)),
        None => format!("Loaded tool {name}, which this request doesn't include."),
    }
}

/// The messages with `render`'s content in place of each tool reference in a result that can't
/// keep its references.
fn replace_references(
    mut messages: Vec<Message>,
    tool_specs: &[ToolSpec],
    kept_references: &HashSet<String>,
    render: impl Fn(&str, Option<&ToolSpec>) -> ToolResultContent,
) -> Vec<Message> {
    if !has_tool_references(&messages) {
        return messages;
    }
    let specs: HashMap<&str, &ToolSpec> = tool_specs.iter().map(|spec| (spec.name.as_str(), spec)).collect();
    let keeps = |content: &ToolResultContent| {
        matches!(content, ToolResultContent::ToolReference(reference)
            if kept_references.contains(&reference.name) && specs.contains_key(reference.name.as_str()))
    };
    for message in &mut messages {
        for block in &mut message.content {
            let ContentBlock::ToolResult(result) = block else {
                continue;
            };
            if !holds_tool_reference(result) || result.content.iter().all(keeps) {
                continue;
            }
            for content in &mut result.content {
                if let ToolResultContent::ToolReference(reference) = content {
                    *content = render(&reference.name, specs.get(reference.name.as_str()).copied());
                }
            }
        }
    }
    messages
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::types::{Role, ToolReferenceBlock};

    fn shell() -> ToolSpec {
        ToolSpec::new("shell", "Run a command")
            .with_input_schema(json!({"type": "object", "properties": {"command": {"type": "string"}}}))
    }

    fn loaded(content: Vec<ToolResultContent>) -> Vec<Message> {
        vec![Message::new(
            Role::User,
            vec![ToolResultBlock::success("t-1", content).into()],
        )]
    }

    fn result_content(messages: &[Message]) -> Vec<ToolResultContent> {
        let ContentBlock::ToolResult(result) = &messages[0].content[0] else {
            panic!("not a tool result");
        };
        result.content.clone()
    }

    #[test]
    fn keeps_a_result_of_only_kept_references_and_renders_mixed_ones_as_text() {
        let reference = ToolResultContent::ToolReference(ToolReferenceBlock::new("shell"));
        let kept = HashSet::from(["shell".to_owned()]);
        let only = with_tool_reference_text(loaded(vec![reference.clone()]), &[shell()], &kept);
        assert_eq!(result_content(&only), vec![reference.clone()]);
        let mixed = with_tool_reference_text(
            loaded(vec![ToolResultContent::text("Not run"), reference]),
            &[shell()],
            &kept,
        );
        assert_eq!(
            result_content(&mixed),
            vec![
                ToolResultContent::text("Not run"),
                ToolResultContent::text(format!("shell parameters: {}", input_schema(&shell()))),
            ]
        );
    }

    #[test]
    fn counts_a_loaded_tool_by_its_schema_and_keeps_the_tracking_id() {
        let messages = loaded(vec![ToolReferenceBlock::new("shell").into()]);
        let tracking_id = messages[0].tracking_id().to_owned();
        let counted = with_tool_reference_schemas(messages, &[shell()]);
        assert_eq!(
            result_content(&counted),
            vec![ToolResultContent::json(input_schema(&shell()))]
        );
        assert_eq!(counted[0].tracking_id(), tracking_id);
    }
}
