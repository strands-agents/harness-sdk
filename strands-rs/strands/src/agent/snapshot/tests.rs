//! Snapshot capture and restore, and round-trips of `conformance/fixtures/snapshots.json` through
//! a real agent.

use std::str::FromStr;

use futures::stream;
use serde_json::json;

use super::*;
use crate::agent::{Agent, AgentConfig};
use crate::clock::test_clock;
use crate::models::streaming::Usage;
use crate::testing::{MockModel, MockTurn, test_agent};
use crate::tools::{FunctionTool, FunctionToolItem};
use crate::types::test_ids;
use crate::types::{
    ContentBlock, InterruptParams, InterruptResponse, Role, StopReason, ToolResultBlock, ToolResultContent,
    ToolResultStatus, ToolUseBlock, UnknownBlock,
};

const MOCK_TIMESTAMP: &str = "2026-01-15T12:00:00.000Z";

fn agent() -> Agent {
    test_agent(MockModel::new())
}

fn snapshot(data: JsonValue) -> Snapshot {
    let JsonValue::Object(data) = data else {
        panic!("snapshot data must be an object");
    };
    Snapshot::new(Scope::Agent, iso_timestamp(), data)
}

fn user(text: &str) -> Message {
    Message::new(Role::User, vec![ContentBlock::text(text)])
}

fn without_tracking_ids(mut value: JsonValue) -> JsonValue {
    if let Some(messages) = value["data"].get_mut("messages").and_then(JsonValue::as_array_mut) {
        for message in messages {
            let id = message.as_object_mut().unwrap().remove("trackingId").unwrap();
            assert!(!id.as_str().unwrap().is_empty());
        }
    }
    value
}

#[test]
fn exports_snapshot_constants_with_correct_values() {
    assert_eq!(SNAPSHOT_SCHEMA_VERSION, "1.0");
    let names: Vec<&str> = ALL_SNAPSHOT_FIELDS.iter().map(|field| field.as_str()).collect();
    assert_eq!(names, ["messages", "state", "systemPrompt", "modelState", "interrupts"]);
    assert_eq!(SnapshotPreset::Session.fields(), ALL_SNAPSHOT_FIELDS);
}

#[test]
fn returns_iso_8601_formatted_timestamp() {
    let _clock = test_clock::fix(MOCK_TIMESTAMP);
    assert_eq!(iso_timestamp(), MOCK_TIMESTAMP);
    drop(_clock);
    let now = iso_timestamp();
    assert_eq!(now.len(), MOCK_TIMESTAMP.len());
    assert!(now.ends_with('Z') && now.as_bytes()[19] == b'.');
}

#[test]
fn throws_error_when_no_fields_would_be_included() {
    let error = resolve_snapshot_fields(&TakeSnapshotOptions::default()).unwrap_err();
    assert!(error.to_string().contains("No fields to include in snapshot"));
}

#[test]
fn returns_session_preset_fields_when_preset_is_session() {
    let fields = resolve_snapshot_fields(&TakeSnapshotOptions::session()).unwrap();
    assert_eq!(fields, ALL_SNAPSHOT_FIELDS);
}

#[test]
fn returns_explicit_fields_when_include_is_specified() {
    let options = TakeSnapshotOptions {
        include: vec![SnapshotField::State, SnapshotField::Messages],
        ..Default::default()
    };
    assert_eq!(
        resolve_snapshot_fields(&options).unwrap(),
        [SnapshotField::Messages, SnapshotField::State]
    );
}

#[test]
fn applies_exclude_after_preset() {
    let options = TakeSnapshotOptions {
        preset: Some(SnapshotPreset::Session),
        exclude: vec![SnapshotField::State],
        ..Default::default()
    };
    assert_eq!(
        resolve_snapshot_fields(&options).unwrap(),
        [
            SnapshotField::Messages,
            SnapshotField::SystemPrompt,
            SnapshotField::ModelState,
            SnapshotField::Interrupts
        ]
    );
}

#[test]
fn throws_error_for_invalid_preset() {
    assert_eq!(SnapshotPreset::from_str("session").unwrap(), SnapshotPreset::Session);
    let error = SnapshotPreset::from_str("invalid").unwrap_err();
    assert_eq!(error.to_string(), "Invalid preset: invalid. Valid presets are: session");
}

#[test]
fn throws_error_for_invalid_field_names() {
    assert_eq!(
        SnapshotField::from_str("modelState").unwrap(),
        SnapshotField::ModelState
    );
    let error = SnapshotField::from_str("invalidField").unwrap_err();
    assert_eq!(
        error.to_string(),
        "Invalid snapshot field: invalidField. Valid fields are: messages, state, systemPrompt, modelState, interrupts"
    );
}

#[test]
fn creates_snapshot_with_session_preset() {
    let _clock = test_clock::fix(MOCK_TIMESTAMP);
    let mut agent = agent();
    agent.messages_mut().push(user("Hello"));
    agent.app_state().set("key", "value").unwrap();
    agent.set_system_prompt(Some("Test prompt".into()));

    let snapshot = agent.take_snapshot(SnapshotPreset::Session).unwrap();

    assert_eq!(
        without_tracking_ids(serde_json::to_value(&snapshot).unwrap()),
        json!({
            "scope": "agent",
            "schemaVersion": "1.0",
            "createdAt": MOCK_TIMESTAMP,
            "data": {
                "messages": [{"role": "user", "content": [{"text": "Hello"}]}],
                "state": {"key": "value"},
                "systemPrompt": "Test prompt",
                "modelState": {},
                "interrupts": {"interrupts": {}, "activated": false}
            },
            "appData": {}
        })
    );
}

#[test]
fn includes_app_data_in_snapshot() {
    let options = TakeSnapshotOptions {
        preset: Some(SnapshotPreset::Session),
        app_data: Some(json!({"customKey": "customValue"}).as_object().unwrap().clone()),
        ..Default::default()
    };
    let snapshot = agent().take_snapshot(options).unwrap();
    assert_eq!(
        JsonValue::Object(snapshot.app_data),
        json!({"customKey": "customValue"})
    );
}

#[test]
fn excludes_specified_fields() {
    let mut agent = agent();
    agent.messages_mut().push(user("Hello"));
    agent.app_state().set("key", "value").unwrap();
    let options = TakeSnapshotOptions {
        preset: Some(SnapshotPreset::Session),
        exclude: vec![SnapshotField::Messages],
        ..Default::default()
    };
    let snapshot = agent.take_snapshot(options).unwrap();
    assert!(!snapshot.data.contains_key("messages"));
    assert!(snapshot.data.contains_key("state"));
}

#[test]
fn throws_error_for_incompatible_schema_version() {
    let mut snapshot = snapshot(json!({}));
    snapshot.schema_version = "2.0".into();
    let error = agent().load_snapshot(&snapshot).unwrap_err();
    assert_eq!(
        error.to_string(),
        "Unsupported snapshot schema version: 2.0. Current version: 1.0"
    );
}

#[test]
fn throws_error_for_wrong_scope() {
    let mut snapshot = snapshot(json!({}));
    snapshot.scope = Scope::MultiAgent;
    let error = agent().load_snapshot(&snapshot).unwrap_err();
    assert_eq!(error.to_string(), "Expected snapshot scope 'agent', got 'multiAgent'");
}

#[test]
fn restores_messages_from_snapshot() {
    let mut agent = agent();
    agent
        .load_snapshot(&snapshot(json!({
            "messages": [{"role": "user", "content": [{"text": "Restored message"}]}]
        })))
        .unwrap();
    assert_eq!(agent.messages().len(), 1);
    assert_eq!(agent.messages()[0].role, Role::User);
    assert_eq!(agent.messages()[0].content, [ContentBlock::text("Restored message")]);
    assert!(!agent.messages()[0].tracking_id().is_empty());
}

#[test]
fn restores_a_message_with_a_content_block_type_this_version_does_not_recognize_unchanged() {
    let saved = json!({
        "role": "user",
        "content": [{"text": "Restored message"}, {"futureBlock": {"value": 1}}],
        "trackingId": "durable-1"
    });
    let mut agent = agent();
    agent.load_snapshot(&snapshot(json!({"messages": [saved]}))).unwrap();

    let message = &agent.messages()[0];
    assert_eq!(message.tracking_id(), "durable-1");
    assert_eq!(message.content[0], ContentBlock::text("Restored message"));
    assert!(matches!(message.content[1], ContentBlock::Unknown(_)));
    let taken = agent.take_snapshot(SnapshotPreset::Session).unwrap();
    assert_eq!(taken.data["messages"], json!([saved]));
}

#[test]
fn restores_a_tool_result_holding_content_this_version_does_not_recognize_unchanged() {
    let saved = json!({
        "role": "user",
        "content": [{"toolResult": {
            "toolUseId": "tool-1",
            "status": "success",
            "content": [{"futureBlock": {"name": "shell"}}]
        }}],
        "trackingId": "durable-1"
    });
    let mut agent = agent();
    agent.load_snapshot(&snapshot(json!({"messages": [saved]}))).unwrap();

    let unknown = UnknownBlock::new(json!({"futureBlock": {"name": "shell"}}).as_object().unwrap().clone());
    assert_eq!(
        agent.messages()[0].content,
        [ContentBlock::ToolResult(ToolResultBlock::new(
            "tool-1",
            ToolResultStatus::Success,
            vec![ToolResultContent::Unknown(unknown)]
        ))]
    );
    let taken = agent.take_snapshot(SnapshotPreset::Session).unwrap();
    assert_eq!(taken.data["messages"], json!([saved]));
}

#[test]
fn restores_state_from_snapshot() {
    let mut agent = agent();
    agent
        .load_snapshot(&snapshot(json!({"state": {"restoredKey": "restoredValue"}})))
        .unwrap();
    assert_eq!(
        agent.app_state().get::<String>("restoredKey").unwrap().as_deref(),
        Some("restoredValue")
    );
}

#[test]
fn restores_system_prompt_from_snapshot() {
    let mut agent = agent();
    agent
        .load_snapshot(&snapshot(json!({"systemPrompt": "Restored system prompt"})))
        .unwrap();
    assert_eq!(
        agent.system_prompt(),
        Some(&SystemPrompt::from("Restored system prompt"))
    );
}

#[test]
fn clears_system_prompt_when_snapshot_has_null_system_prompt_agent_had_no_system_prompt_at_snapshot_time() {
    let mut agent = agent();
    agent.set_system_prompt(Some("Original prompt".into()));
    agent.load_snapshot(&snapshot(json!({"systemPrompt": null}))).unwrap();
    assert_eq!(agent.system_prompt(), None);
}

#[test]
fn leaves_system_prompt_unchanged_when_system_prompt_key_is_absent_from_snapshot() {
    let mut agent = agent();
    agent.set_system_prompt(Some("Original prompt".into()));
    agent.load_snapshot(&snapshot(json!({"messages": []}))).unwrap();
    assert_eq!(agent.system_prompt(), Some(&SystemPrompt::from("Original prompt")));
}

#[test]
fn leaves_messages_unchanged_when_messages_key_is_absent_from_snapshot() {
    let mut agent = agent();
    agent.messages_mut().push(user("Existing"));
    agent
        .load_snapshot(&snapshot(json!({"state": {"key": "val"}})))
        .unwrap();
    assert_eq!(agent.messages().len(), 1);
}

#[test]
fn leaves_state_unchanged_when_state_key_is_absent_from_snapshot() {
    let mut agent = agent();
    agent.app_state().set("existing", "value").unwrap();
    agent.load_snapshot(&snapshot(json!({"messages": []}))).unwrap();
    assert_eq!(
        agent.app_state().get::<String>("existing").unwrap().as_deref(),
        Some("value")
    );
}

#[test]
fn restores_nothing_when_part_of_the_snapshot_does_not_decode() {
    let mut agent = agent();
    agent.messages_mut().push(user("Existing"));
    let error = agent
        .load_snapshot(&snapshot(json!({"messages": [], "systemPrompt": 42})))
        .unwrap_err();
    assert!(!error.to_string().is_empty());
    assert_eq!(agent.messages().len(), 1);
}

#[test]
fn preserves_messages_through_save_load_cycle() {
    let mut agent = agent();
    let original = vec![
        user("Hello"),
        Message::new(Role::Assistant, vec![ContentBlock::text("Hi!")]),
    ];
    agent.messages_mut().extend(original.clone());
    let snapshot = agent.take_snapshot(SnapshotPreset::Session).unwrap();
    *agent.messages_mut() = vec![user("Different")];
    agent.load_snapshot(&snapshot).unwrap();
    assert_eq!(agent.messages(), original);
}

#[test]
fn preserves_state_through_save_load_cycle() {
    let mut agent = agent();
    agent.app_state().set("userId", "user-123").unwrap();
    agent.app_state().set("counter", 42).unwrap();
    let snapshot = agent.take_snapshot(SnapshotPreset::Session).unwrap();
    agent.app_state().clear();
    agent.app_state().set("different", "value").unwrap();
    agent.load_snapshot(&snapshot).unwrap();
    assert_eq!(
        JsonValue::Object(agent.app_state().get_all()),
        json!({"userId": "user-123", "counter": 42})
    );
}

#[test]
fn handles_complex_message_content() {
    let mut agent = agent();
    let original = vec![
        Message::new(
            Role::Assistant,
            vec![
                ToolUseBlock::new(
                    "calculator",
                    "tool-123",
                    json!({"operation": "add", "numbers": [1, 2, 3]}),
                )
                .into(),
            ],
        ),
        Message::new(
            Role::User,
            vec![ContentBlock::ToolResult(ToolResultBlock::new(
                "tool-123",
                ToolResultStatus::Success,
                vec![ToolResultContent::text("6")],
            ))],
        ),
    ];
    agent.messages_mut().extend(original.clone());
    let snapshot = agent
        .take_snapshot(TakeSnapshotOptions {
            include: vec![SnapshotField::Messages],
            ..Default::default()
        })
        .unwrap();
    agent.messages_mut().clear();
    agent.load_snapshot(&snapshot).unwrap();
    assert_eq!(agent.messages(), original);
}

#[test]
fn snapshot_survives_json_stringify_json_parse_round_trip() {
    let mut agent = agent();
    agent.messages_mut().push(user("Hello"));
    agent.app_state().set("userId", "user-123").unwrap();
    agent.set_system_prompt(Some("You are a helpful assistant".into()));
    let snapshot = agent.take_snapshot(SnapshotPreset::Session).unwrap();
    let parsed: Snapshot = serde_json::from_str(&serde_json::to_string(&snapshot).unwrap()).unwrap();
    assert_eq!(parsed, snapshot);
}

#[test]
fn snapshot_can_be_stored_and_retrieved_as_json_string() {
    let mut agent = agent();
    agent.messages_mut().push(user("Test message"));
    agent.app_state().set("key", "value").unwrap();
    let stored = serde_json::to_string(&agent.take_snapshot(SnapshotPreset::Session).unwrap()).unwrap();

    let mut restored = self::agent();
    restored.load_snapshot(&serde_json::from_str(&stored).unwrap()).unwrap();
    assert_eq!(restored.messages().len(), 1);
    assert_eq!(
        JsonValue::Object(restored.app_state().get_all()),
        json!({"key": "value"})
    );
}

fn confirm_tool(name: &'static str, interrupt: &'static str, reason: &'static str) -> FunctionTool {
    FunctionTool::builder(name, "asks for confirmation").callback(move |_input, ctx| async move {
        let response = ctx.interrupt(InterruptParams::new(interrupt).with_reason(reason))?;
        Ok(json!(format!("confirmed: {response}")))
    })
}

async fn interrupt_snapshot_and_resume(
    name: &'static str,
    interrupt: &'static str,
    reason: &'static str,
    response: &'static str,
) {
    let model = MockModel::from_turns([
        MockTurn::content([ToolUseBlock::new(name, "tool-1", json!({"action": "delete"}))]),
        MockTurn::text("Done"),
    ]);
    let mut agent = test_agent(model);
    agent
        .tool_registry_mut()
        .add(confirm_tool(name, interrupt, reason))
        .unwrap();
    let interrupted = agent.invoke("Delete it").await.unwrap();
    assert_eq!(interrupted.stop_reason(), StopReason::Interrupt);
    assert_eq!(interrupted.interrupts().len(), 1);

    let snapshot = agent.take_snapshot(SnapshotPreset::Session).unwrap();
    assert!(snapshot.data.contains_key("interrupts"));

    let mut restored = test_agent(MockModel::new().with_turn("Done"));
    restored
        .tool_registry_mut()
        .add(confirm_tool(name, interrupt, reason))
        .unwrap();
    restored.load_snapshot(&snapshot).unwrap();
    let response = InterruptResponse::new(interrupted.interrupts()[0].id.clone(), json!(response));
    let result = restored.invoke(vec![response]).await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
}

#[tokio::test]
async fn preserves_interrupt_state_through_snapshot_and_restores_for_resume() {
    interrupt_snapshot_and_resume("confirmTool", "confirm", "Confirm delete?", "yes").await;
}

#[test]
fn take_snapshot_captures_state_and_load_snapshot_restores_it_round_trip() {
    let _clock = test_clock::fix(MOCK_TIMESTAMP);
    let mut agent = agent();
    agent.messages_mut().push(user("Hello"));
    agent
        .messages_mut()
        .push(Message::new(Role::Assistant, vec![ContentBlock::text("Hi!")]));
    agent.app_state().set("counter", 42).unwrap();
    agent.set_system_prompt(Some("Be helpful".into()));

    let snapshot = agent.take_snapshot(SnapshotPreset::Session).unwrap();
    assert_eq!(
        without_tracking_ids(serde_json::to_value(&snapshot).unwrap()),
        json!({
            "scope": "agent",
            "schemaVersion": "1.0",
            "createdAt": MOCK_TIMESTAMP,
            "data": {
                "messages": [
                    {"role": "user", "content": [{"text": "Hello"}]},
                    {"role": "assistant", "content": [{"text": "Hi!"}]}
                ],
                "state": {"counter": 42},
                "systemPrompt": "Be helpful",
                "modelState": {},
                "interrupts": {"interrupts": {}, "activated": false}
            },
            "appData": {}
        })
    );

    agent.messages_mut().clear();
    agent.app_state().clear();
    agent.set_system_prompt(Some("Different".into()));
    agent.load_snapshot(&snapshot).unwrap();
    assert_eq!(agent.messages().len(), 2);
    assert_eq!(agent.app_state().get::<u64>("counter").unwrap(), Some(42));
    assert_eq!(agent.system_prompt(), Some(&SystemPrompt::from("Be helpful")));
}

#[test]
fn propagates_errors_from_load_snapshot_for_invalid_snapshots() {
    let mut agent = agent();
    let mut bad_version = Snapshot::new(Scope::Agent, "", JsonObject::new());
    bad_version.schema_version = "99.0".into();
    assert!(
        agent
            .load_snapshot(&bad_version)
            .unwrap_err()
            .to_string()
            .starts_with("Unsupported snapshot schema version: 99.0")
    );
    let other_scope = Snapshot::new(Scope::MultiAgent, "", JsonObject::new());
    assert_eq!(
        agent.load_snapshot(&other_scope).unwrap_err().to_string(),
        "Expected snapshot scope 'agent', got 'multiAgent'"
    );
    assert!(
        agent
            .take_snapshot(TakeSnapshotOptions::default())
            .unwrap_err()
            .to_string()
            .contains("No fields to include in snapshot")
    );
}

#[test]
fn supports_json_serialization_round_trip() {
    let mut agent = agent();
    agent.messages_mut().push(user("Persist me"));
    agent.app_state().set("session", "abc").unwrap();
    let json = serde_json::to_string(&agent.take_snapshot(SnapshotPreset::Session).unwrap()).unwrap();
    let mut restored = self::agent();
    restored.load_snapshot(&serde_json::from_str(&json).unwrap()).unwrap();
    assert_eq!(restored.messages().len(), 1);
    assert_eq!(
        restored.app_state().get::<String>("session").unwrap().as_deref(),
        Some("abc")
    );
}

#[tokio::test]
async fn preserves_and_restores_interrupt_state_for_resume() {
    interrupt_snapshot_and_resume("askUser", "ask", "Need confirmation", "go ahead").await;
}

fn conformance_agent(system_prompt: Option<SystemPrompt>) -> Agent {
    let model = MockModel::from_turns([
        MockTurn::content([
            ContentBlock::text("Let me check."),
            ToolUseBlock::new("get_weather", "tooluse-weather-1", json!({"city": "Seattle"})).into(),
        ])
        .with_usage(Usage::new(20, 10, 30)),
        MockTurn::text("It is sunny in Seattle.").with_usage(Usage::new(40, 8, 48)),
    ]);
    let weather = FunctionTool::builder("get_weather", "Get the weather for a city")
        .input_schema(json!({"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}))
        .stream_callback(|input, _ctx| {
            let city = input["city"].clone();
            stream::iter([
                Ok(FunctionToolItem::Update(json!({"progress": "looking up"}))),
                Ok(FunctionToolItem::Return(
                    json!({"city": city, "forecast": "sunny", "high": 22}),
                )),
            ])
        });
    Agent::new(AgentConfig {
        model: Some(model.into()),
        tools: vec![weather.into()],
        printer: Some(false),
        name: Some("conformance_agent".into()),
        id: Some("conformance-agent".into()),
        system_prompt,
        app_state: Some(json!({"units": "metric", "visits": 1}).as_object().unwrap().clone()),
        ..Default::default()
    })
    .unwrap()
}

fn fixture_cases() -> Vec<(String, String)> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../conformance/fixtures/snapshots.json");
    let fixture: JsonValue = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    fixture["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|case| {
            (
                case["name"].as_str().unwrap().to_owned(),
                case["json"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

/// Gives the Rust snapshot's messages the tracking ids recorded in the fixture.
fn with_fixture_tracking_ids(rust: &Snapshot, fixture: &str) -> String {
    let fixture: JsonValue = serde_json::from_str(fixture).unwrap();
    let mut rust = serde_json::to_value(rust).unwrap();
    if let Some(messages) = rust["data"].get_mut("messages").and_then(JsonValue::as_array_mut) {
        let expected = fixture["data"]["messages"].as_array().unwrap();
        assert_eq!(messages.len(), expected.len());
        for (message, expected) in messages.iter_mut().zip(expected) {
            assert!(
                message["trackingId"]
                    .as_str()
                    .unwrap()
                    .starts_with("00000000-0000-4000-8000-")
            );
            message["trackingId"] = expected["trackingId"].clone();
        }
    }
    serde_json::to_string(&rust).unwrap()
}

#[tokio::test]
async fn conformance_snapshots_match_what_a_ts_agent_takes() {
    let _clock = test_clock::fix("2026-11-11T12:00:00.000Z");
    let _ids = test_ids::count_from(0);
    let mut agent = conformance_agent(Some("You are a weather assistant.".into()));
    agent.invoke("What is the weather in Seattle?").await.unwrap();
    let blocks = SystemPrompt::Blocks(
        serde_json::from_value(json!([
            {"text": "You are a weather assistant."},
            {"cachePoint": {"cacheType": "default"}},
            {"guardContent": {"text": {"qualifiers": ["guard_content"], "text": "Be safe."}}}
        ]))
        .unwrap(),
    );
    let mut block_prompt_agent = conformance_agent(Some(blocks));
    block_prompt_agent
        .invoke("What is the weather in Seattle?")
        .await
        .unwrap();
    let mut no_prompt_agent = conformance_agent(None);
    no_prompt_agent.invoke("What is the weather in Seattle?").await.unwrap();

    let app_data = json!({"release": "v1", "counters": {"saves": 2}})
        .as_object()
        .unwrap()
        .clone();
    let take = |agent: &Agent, options: TakeSnapshotOptions| agent.take_snapshot(options).unwrap();
    let include = |fields: &[SnapshotField]| TakeSnapshotOptions {
        include: fields.to_vec(),
        ..Default::default()
    };
    let snapshots = [
        ("session_preset", take(&agent, TakeSnapshotOptions::session())),
        (
            "session_preset_app_data",
            take(
                &agent,
                TakeSnapshotOptions {
                    app_data: Some(app_data),
                    ..TakeSnapshotOptions::session()
                },
            ),
        ),
        (
            "include_messages_state",
            take(&agent, include(&[SnapshotField::Messages, SnapshotField::State])),
        ),
        (
            "session_preset_exclude_interrupts",
            take(
                &agent,
                TakeSnapshotOptions {
                    exclude: vec![SnapshotField::Interrupts],
                    ..TakeSnapshotOptions::session()
                },
            ),
        ),
        (
            "system_prompt_blocks",
            take(&block_prompt_agent, include(&[SnapshotField::SystemPrompt])),
        ),
        (
            "system_prompt_absent",
            take(
                &no_prompt_agent,
                include(&[SnapshotField::SystemPrompt, SnapshotField::ModelState]),
            ),
        ),
    ];
    let cases = fixture_cases();
    for (name, snapshot) in snapshots {
        let (_, expected) = cases.iter().find(|(case, _)| case == name).unwrap();
        assert_eq!(&with_fixture_tracking_ids(&snapshot, expected), expected, "case {name}");
    }
}
