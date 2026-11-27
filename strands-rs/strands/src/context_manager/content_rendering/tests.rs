use serde_json::json;

use super::*;
use crate::types::{
    AudioBlock, AudioFormat, AudioSource, CachePointBlock, CitationGeneratedContent, CitationsBlock, GuardContentBlock,
    GuardContentText, ImageBlock, ImageFormat, ImageSource, InjectedBlock, JsonBlock, ReasoningBlock, SummaryBlock,
    TextBlock, ToolResultBlock, ToolUseBlock, VideoBlock, VideoFormat, VideoSource,
};

fn text(value: &str) -> ContentBlock {
    ContentBlock::text(value)
}

fn reasoning() -> ContentBlock {
    ContentBlock::Reasoning(ReasoningBlock::new().with_text("plan").with_signature("sig"))
}

fn tool_use(id: &str) -> ContentBlock {
    ContentBlock::ToolUse(ToolUseBlock::new("shell", id, json!({"command": "ls"})))
}

fn result(id: &str, status: ToolResultStatus, value: &str) -> ContentBlock {
    ContentBlock::ToolResult(ToolResultBlock::new(id, status, vec![ToolResultContent::text(value)]))
}

#[test]
fn excludes_reasoning_blocks() {
    let messages = [Message::new(Role::Assistant, vec![reasoning(), text("hi")])];
    assert_eq!(
        flatten_messages_to_content(&messages),
        [text("\n---\n[assistant]"), text("hi")]
    );
}

#[test]
fn skips_the_role_marker_for_a_message_with_only_reasoning() {
    let messages = [
        Message::new(Role::Assistant, vec![reasoning()]),
        Message::new(Role::User, vec![text("next")]),
    ];
    assert_eq!(
        flatten_messages_to_content(&messages),
        [text("\n---\n[user]"), text("next")]
    );
}

#[test]
fn leaves_out_injected_text() {
    let messages = [Message::new(
        Role::User,
        vec![
            text("fix the build"),
            ContentBlock::Injected(InjectedBlock::new("<todos>v1</todos>", "strands:todos:injector")),
        ],
    )];
    assert_eq!(
        flatten_messages_to_content(&messages),
        [text("\n---\n[user]"), text("fix the build")]
    );
}

#[test]
fn passes_only_text_images_and_documents_through_and_renders_other_blocks_as_text() {
    let image = ContentBlock::Image(ImageBlock::new(ImageFormat::Png, ImageSource::Bytes(vec![1])));
    let video = || VideoBlock::new(VideoFormat::Mp4, VideoSource::Bytes(vec![1]));
    let messages = [
        Message::new(
            Role::User,
            vec![
                ContentBlock::GuardContent(GuardContentBlock::Text(GuardContentText::new(
                    Vec::new(),
                    "guarded text",
                ))),
                ContentBlock::Video(video()),
                ContentBlock::Audio(AudioBlock::new(AudioFormat::Mp3, AudioSource::Bytes(vec![1]))),
                image.clone(),
                ContentBlock::CachePoint(CachePointBlock::new()),
                ContentBlock::ToolResult(ToolResultBlock::success(
                    "call_1",
                    vec![
                        ToolResultContent::Json(JsonBlock::new(json!({"ok": true}))),
                        ToolResultContent::Video(video()),
                    ],
                )),
            ],
        ),
        Message::new(
            Role::Assistant,
            vec![ContentBlock::Citations(CitationsBlock::new(
                Vec::new(),
                vec![CitationGeneratedContent::new("cited answer")],
            ))],
        ),
    ];
    assert_eq!(
        flatten_messages_to_content(&messages),
        [
            text("\n---\n[user]"),
            text("guarded text"),
            text("[video omitted]"),
            text("[audio omitted]"),
            image,
            text("[tool result]"),
            text("{\n  \"ok\": true\n}"),
            text("[video omitted]"),
            text("\n---\n[assistant]"),
            text("cited answer"),
        ]
    );
}

#[test]
fn renders_a_summary_block_as_its_text() {
    let messages = [Message::new(
        Role::Assistant,
        vec![ContentBlock::Summary(
            SummaryBlock::new("earlier facts")
                .with_provider("anthropic")
                .with_signature("sig"),
        )],
    )];
    assert_eq!(
        flatten_messages_to_content(&messages),
        [text("\n---\n[assistant]"), text("earlier facts")]
    );
}

// guards against tool-use blocks reaching the summarizer in a user turn (#5291)
#[test]
fn renders_tool_calls_and_their_results_as_labeled_text() {
    let history = [
        Message::new(Role::User, vec![text("fix the build")]),
        Message::new(Role::Assistant, vec![tool_use("call_1")]),
        Message::new(
            Role::User,
            vec![result("call_1", ToolResultStatus::Success, "a.ts b.ts")],
        ),
    ];
    assert_eq!(
        flatten_messages_to_content(&history),
        [
            text("\n---\n[user]"),
            text("fix the build"),
            text("\n---\n[assistant]"),
            text("[tool call: shell] {\"command\":\"ls\"}"),
            text("\n---\n[user]"),
            text("[tool result: shell]"),
            text("a.ts b.ts"),
        ]
    );
}

#[test]
fn labels_error_results_and_results_without_a_matching_call() {
    let messages = [
        Message::new(
            Role::User,
            vec![
                result("call_2", ToolResultStatus::Error, "not found"),
                result("call_3", ToolResultStatus::Success, "ok"),
            ],
        ),
        Message::new(Role::Assistant, vec![tool_use("call_1")]),
        Message::new(Role::User, vec![result("call_1", ToolResultStatus::Error, "denied")]),
    ];
    assert_eq!(
        flatten_messages_to_content(&messages),
        [
            text("\n---\n[user]"),
            text("[tool result (error)]"),
            text("not found"),
            text("[tool result]"),
            text("ok"),
            text("\n---\n[assistant]"),
            text("[tool call: shell] {\"command\":\"ls\"}"),
            text("\n---\n[user]"),
            text("[tool result: shell (error)]"),
            text("denied"),
        ]
    );
}

#[test]
fn converts_text_content() {
    assert_eq!(
        tool_result_to_content_blocks(&[ToolResultContent::text("hello")]),
        [text("hello")]
    );
}

#[test]
fn passes_through_images() {
    let image = ImageBlock::new(ImageFormat::Png, ImageSource::Bytes(vec![1, 2, 3]));
    assert_eq!(
        tool_result_to_content_blocks(&[ToolResultContent::Image(image.clone())]),
        [ContentBlock::Image(image)]
    );
}

#[test]
fn converts_json_content_to_text() {
    assert_eq!(
        tool_result_to_content_blocks(&[
            ToolResultContent::text("plain text"),
            ToolResultContent::Json(JsonBlock::new(json!({"key": "value", "count": 42}))),
        ]),
        [
            text("plain text"),
            ContentBlock::Text(TextBlock::new("{\n  \"key\": \"value\",\n  \"count\": 42\n}")),
        ]
    );
}
