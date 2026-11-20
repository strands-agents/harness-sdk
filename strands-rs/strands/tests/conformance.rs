//! Round-trips the TS-produced fixtures in `strands-rs/conformance/fixtures/` byte for byte.
//!
//! Each case's `json` is the exact `JSON.stringify` output of a strands-ts value. It is parsed into
//! the Rust type and serialized again with `serde_json::to_string`; the strings must match. A case
//! with an `input` records data TS read and normalized: Rust parses `input` and must write `json`.
//!
//! The cases in [`DIVERGENT`] are the documented exceptions in `strands-rs/docs/DIVERGENCES.md`.
//! The `metrics` cases are tables of instrument and span names with no Rust wire type: they
//! round-trip as JSON here, and `src/telemetry/tests/meter.rs` and `span_names_match_a_rust_agent_run`
//! compare them with what the meter and a Rust agent run produce. The persisted interrupt state is
//! crate-internal, so its round trip is tested in `src/interrupt.rs`.
//!
//! The agent stream and hook event fixtures also come from real TS agent runs
//! (`conformance/generate.ts`, `conformanceAgent` and `interruptAgent`); the `*_match_a_rust_agent_run`
//! tests rebuild those agents on `MockModel` and compare the records a Rust run produces, with
//! tracking ids normalized.

#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "test helpers report fixture failures by panicking"
)]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use futures::StreamExt;
use indexmap::IndexMap;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::json;
use strands::hooks::{
    AfterInvocationEvent, AfterModelCallEvent, AfterToolCallEvent, AfterToolsEvent, AgentResultEvent,
    BeforeInvocationEvent, BeforeModelCallEvent, BeforeToolCallEvent, BeforeToolsEvent, ContentBlockEvent,
    InitializedEvent, InitializedEventData, InterruptEvent, MessageAddedEvent, ModelMessageEvent,
    ModelStreamUpdateEvent, ToolResultEvent, ToolStreamUpdateEvent,
};
use strands::testing::{MockModel, MockTurn};
use strands::tools::{FunctionTool, FunctionToolItem};
use strands::{
    Agent, AgentResult, AgentStreamEvent, ContentBlock, ContentBlockDelta, Interrupt, InterruptParams,
    InterruptResponseContent, JsonValue, Message, ModelStreamEvent, Snapshot, SystemPrompt, ToolError, ToolUseBlock,
    Usage,
};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Divergence {
    /// JS and serde_json format some numbers differently (`1e+21` and `1e21`); the values match.
    NumberFormat,
    /// serde_json rejects a lone UTF-16 surrogate escape that JS accepts.
    LoneSurrogate,
    /// TS writes redacted reasoning bytes in stream events as an index-keyed object; Rust reads it and
    /// writes base64.
    IndexKeyedBytes,
    /// JS writes integer-like object keys first, in numeric order; serde_json keeps the order it
    /// read. The values match.
    IntegerKeyOrder,
}

const DIVERGENT: [(&str, Divergence); 4] = [
    ("tool_use_block_number_forms", Divergence::NumberFormat),
    ("tool_use_block_integer_like_keys", Divergence::IntegerKeyOrder),
    ("text_block_lone_surrogate", Divergence::LoneSurrogate),
    (
        "content_block_delta_reasoning_redacted_content",
        Divergence::IndexKeyedBytes,
    ),
];

#[derive(serde::Deserialize)]
struct Fixture {
    source: String,
    cases: Vec<Case>,
}

#[derive(serde::Deserialize)]
struct Case {
    name: String,
    json: String,
    input: Option<String>,
}

fn fixture(area: &str) -> Fixture {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../conformance/fixtures")
        .join(format!("{area}.json"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    let fixture: Fixture = serde_json::from_str(&text).unwrap();
    assert!(
        fixture.source.starts_with("strands-ts/src/"),
        "{area}: unexpected source"
    );
    assert!(!fixture.cases.is_empty(), "{area}: no cases");
    fixture
}

fn divergence(case: &Case) -> Option<Divergence> {
    DIVERGENT
        .iter()
        .find_map(|(name, kind)| (*name == case.name).then_some(*kind))
}

fn round_trip<T: Serialize + DeserializeOwned>(area: &str, case: &Case) -> Option<T> {
    let label = format!("{area}/{}", case.name);
    if divergence(case) == Some(Divergence::LoneSurrogate) {
        assert!(
            serde_json::from_str::<T>(&case.json).is_err(),
            "{label}: expected a parse error"
        );
        return None;
    }
    let source = case.input.as_deref().unwrap_or(&case.json);
    let value: T = serde_json::from_str(source).unwrap_or_else(|error| panic!("{label}: {error}"));
    let written = serde_json::to_string(&value).unwrap();
    match divergence(case) {
        Some(Divergence::NumberFormat) => assert_eq!(
            serde_json::from_str::<JsonValue>(&written).unwrap(),
            serde_json::from_str::<JsonValue>(&case.json).unwrap(),
            "{label}: values differ"
        ),
        Some(Divergence::IntegerKeyOrder) => {
            assert_eq!(written, source, "{label}: expected the input's key order");
            assert_eq!(
                serde_json::from_str::<JsonValue>(&written).unwrap(),
                serde_json::from_str::<JsonValue>(&case.json).unwrap(),
                "{label}: values differ"
            );
        }
        Some(Divergence::IndexKeyedBytes | Divergence::LoneSurrogate) => {}
        None => assert_eq!(written, case.json, "{label} did not round-trip"),
    }
    Some(value)
}

fn check_snapshot(area: &str, case: &Case) {
    let Some(snapshot) = round_trip::<Snapshot>(area, case) else {
        return;
    };
    let typed = [
        ("messages", check_value::<Vec<Message>> as fn(&str, &JsonValue)),
        ("systemPrompt", check_value::<Option<SystemPrompt>>),
    ];
    for (key, check) in typed {
        if let Some(value) = snapshot.data.get(key) {
            check(&format!("{area}/{}/{key}", case.name), value);
        }
    }
}

fn check_value<T: Serialize + DeserializeOwned>(label: &str, value: &JsonValue) {
    let expected = serde_json::to_string(value).unwrap();
    let typed: T = serde_json::from_str(&expected).unwrap_or_else(|error| panic!("{label}: {error}"));
    assert_eq!(
        serde_json::to_string(&typed).unwrap(),
        expected,
        "{label} did not round-trip"
    );
}

#[test]
fn messages_and_content_blocks_round_trip() {
    let fixture = fixture("messages");
    for case in &fixture.cases {
        if case.name.starts_with("message_") {
            round_trip::<Message>("messages", case);
        } else {
            round_trip::<ContentBlock>("messages", case);
        }
    }
}

#[test]
fn model_stream_events_round_trip() {
    let fixture = fixture("model_stream_events");
    for case in &fixture.cases {
        round_trip::<ModelStreamEvent>("model_stream_events", case);
    }
}

#[test]
fn ts_index_keyed_redacted_content_reads_as_bytes_and_writes_base64() {
    let fixture = fixture("model_stream_events");
    let case = fixture
        .cases
        .iter()
        .find(|case| divergence(case) == Some(Divergence::IndexKeyedBytes))
        .unwrap();
    let event: ModelStreamEvent = serde_json::from_str(&case.json).unwrap();
    let ModelStreamEvent::ContentBlockDelta(delta) = &event else {
        panic!("expected a delta event");
    };
    let ContentBlockDelta::ReasoningContent(reasoning) = &delta.delta else {
        panic!("expected a reasoning delta");
    };
    assert_eq!(reasoning.redacted_content, Some(vec![1, 2, 3]));
    assert_eq!(
        serde_json::to_string(&event).unwrap(),
        r#"{"type":"modelContentBlockDeltaEvent","delta":{"type":"reasoningContentDelta","redactedContent":"AQID"}}"#
    );
}

#[test]
fn snapshots_round_trip() {
    let fixture = fixture("snapshots");
    for case in &fixture.cases {
        check_snapshot("snapshots", case);
    }
}

#[test]
fn interrupts_round_trip() {
    let fixture = fixture("interrupts");
    for case in &fixture.cases {
        let name = case.name.as_str();
        if name == "interrupt_response_content" {
            round_trip::<InterruptResponseContent>("interrupts", case);
        } else if name.starts_with("interrupt_state_") {
            round_trip::<JsonValue>("interrupts", case);
        } else if name.starts_with("agent_result_") {
            round_trip::<AgentResult>("interrupts", case);
        } else if name.starts_with("interrupt_") {
            round_trip::<Interrupt>("interrupts", case);
        } else if name.starts_with("snapshot_") {
            check_snapshot("interrupts", case);
        } else {
            panic!("interrupts/{name}: no Rust type mapped");
        }
    }
}

#[test]
fn session_files_round_trip_as_snapshots() {
    let fixture = fixture("sessions");
    for case in &fixture.cases {
        if case.name.starts_with("snapshot_") || case.name.starts_with("immutable_history_") {
            check_snapshot("sessions", case);
        } else {
            round_trip::<JsonValue>("sessions", case);
        }
    }
}

#[test]
fn agent_stream_events_round_trip() {
    let fixture = fixture("agent_stream_events");
    for case in &fixture.cases {
        let event = round_trip::<AgentStreamEvent>("agent_stream_events", case).unwrap();
        assert!(
            case.json.contains(&format!("\"type\":\"{}\"", event.event_type())),
            "{}",
            case.name
        );
    }
}

#[test]
fn hook_event_records_round_trip() {
    let fixture = fixture("hook_events");
    for case in &fixture.cases {
        if case.name == "initialized_event" {
            round_trip::<InitializedEventData>("hook_events", case);
        } else {
            round_trip::<AgentStreamEvent>("hook_events", case);
        }
    }
}

/// The stash cases of `generate.ts` (`stashCases`), rebuilt with the Rust stash and compared
/// byte for byte: storage keys, every stored entry, `take_snapshot` and the storage type names.
/// The two session snapshot envelopes need the session manager and round-trip as JSON.
#[tokio::test]
async fn stash_cases_match_a_rust_stash() {
    use strands::experimental::context_manager::Stash;
    use strands::storage::{InMemoryStorage, LocalFileStorage, Storage};
    use strands::types::{
        CachePointBlock, ImageBlock, ImageFormat, ImageSource, JsonBlock, Role, ToolResultBlock, ToolResultContent,
    };

    let fixture = fixture("stash");
    let case = |name: &str| {
        fixture
            .cases
            .iter()
            .find(|case| case.name == name)
            .unwrap()
            .json
            .clone()
    };
    let storage = Arc::new(InMemoryStorage::new());
    let stash = Stash::new(storage.clone(), "conformance-session", "conformance-agent").unwrap();
    let bytes = vec![0, 1, 2, 3, 250, 251, 252, 253, 254, 255];
    let first = Message::new(
        Role::User,
        vec![
            ContentBlock::text("Here is a picture."),
            ContentBlock::Image(ImageBlock::new(ImageFormat::Png, ImageSource::Bytes(bytes))),
            ContentBlock::CachePoint(CachePointBlock::new()),
        ],
    )
    .with_tracking_id("message-1");
    let second = Message::new(
        Role::User,
        vec![ContentBlock::ToolResult(ToolResultBlock::success(
            "tooluse-stash-1",
            vec![
                ToolResultContent::text("long tool output"),
                ToolResultContent::Json(JsonBlock::new(json!({"rows": [1, 2, 3]}))),
            ],
        ))],
    )
    .with_tracking_id("message-2");
    stash.store_message(&first, None).await;
    stash.store_message(&second, None).await;

    let keys = storage.list("").await.unwrap();
    assert_eq!(serde_json::to_string(&keys).unwrap(), case("storage_keys"));
    for key in &keys {
        let name = format!("entry_{}", key.rsplit('/').next().unwrap().replace('-', "_"));
        let stored = storage.read(key).await.unwrap().unwrap();
        assert_eq!(String::from_utf8(stored).unwrap(), case(&name), "{name}");
    }
    assert_eq!(
        serde_json::to_string(&stash.take_snapshot().await.unwrap()).unwrap(),
        case("take_snapshot")
    );
    assert_eq!(
        json!(stash.storage_type_name()).to_string(),
        case("storage_type_name_in_memory")
    );
    let dir = tempfile::tempdir().unwrap();
    let file_stash = Stash::new(Arc::new(LocalFileStorage::new(dir.path())), "s", "a").unwrap();
    assert_eq!(
        json!(file_stash.storage_type_name()).to_string(),
        case("storage_type_name_local_file")
    );
    assert_eq!(snapshot_stash_inline().await, case("snapshot_stash_inline"));
    assert_eq!(snapshot_stash_external().await, case("snapshot_stash_external"));
}

/// `conformanceAgent` with a context manager and an optional session manager.
fn conformance_agent_with(
    context_manager: strands::experimental::context_manager::ContextManagerConfig,
    session_manager: Option<strands::session::SessionManager>,
) -> Agent {
    let model = MockModel::new()
        .with_turn(
            MockTurn::content([
                ContentBlock::text("Let me check."),
                ToolUseBlock::new("get_weather", "tooluse-weather-1", json!({"city": "Seattle"})).into(),
            ])
            .with_usage(Usage::new(20, 10, 30)),
        )
        .with_turn(MockTurn::text("It is sunny in Seattle.").with_usage(Usage::new(40, 8, 48)));
    let app_state = json!({"units": "metric", "visits": 1});
    Agent::builder()
        .model(model)
        .tools([weather_tool()])
        .printer(false)
        .name("conformance_agent")
        .id("conformance-agent")
        .system_prompt("You are a weather assistant.")
        .app_state(app_state.as_object().unwrap().clone())
        .context_manager(context_manager)
        .maybe_session_manager(session_manager)
        .build()
        .unwrap()
}

fn no_retrieval_tool(
    storage: Option<Arc<dyn strands::storage::Storage>>,
) -> strands::experimental::context_manager::ContextManagerConfig {
    use strands::experimental::context_manager::{ContextManagerConfig, StashConfig};
    ContextManagerConfig {
        stash: Some(
            StashConfig {
                storage,
                retrieval_tool: Some(false),
            }
            .into(),
        ),
        ..ContextManagerConfig::default()
    }
}

/// The `snapshot_stash_inline` case: the stash envelope of the session snapshot after one run,
/// with the run's message tracking ids replaced by the ones the TS generator fixes and the entries
/// re-sorted as storage lists them.
async fn snapshot_stash_inline() -> String {
    use strands::session::SessionManager;
    use strands::storage::{InMemoryStorage, Storage};

    let storage = Arc::new(InMemoryStorage::new());
    let session = SessionManager::builder()
        .storage(storage.clone())
        .session_id("stash-inline-session")
        .build()
        .unwrap();
    let mut agent = conformance_agent_with(no_retrieval_tool(None), Some(session));
    agent.invoke("What is the weather in Seattle?").await.unwrap();
    let ts_ids = [
        (0, "00000000-0000-4000-8000-000000000069"),
        (1, "00000000-0000-4000-8000-00000000006d"),
        (3, "00000000-0000-4000-8000-000000000075"),
    ];
    let renames: Vec<(String, &str)> = ts_ids
        .iter()
        .map(|&(index, id)| (agent.messages()[index].tracking_id().to_owned(), id))
        .collect();
    let bytes = storage
        .read("session/stash-inline-session/scopes/agent/conformance-agent/snapshots/snapshot_latest.json")
        .await
        .unwrap()
        .unwrap();
    let snapshot: JsonValue = serde_json::from_slice(&bytes).unwrap();
    let stash = snapshot["data"]["stash"].as_object().unwrap().clone();
    let mut entries: Vec<(String, JsonValue)> = stash["entries"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(key, value)| {
            let key = renames
                .iter()
                .fold(key.clone(), |key, (from, to)| key.replace(from.as_str(), to));
            (key, value.clone())
        })
        .collect();
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    let mut envelope = serde_json::Map::new();
    envelope.insert("location".to_owned(), stash["location"].clone());
    envelope.insert("entries".to_owned(), JsonValue::Object(entries.into_iter().collect()));
    serde_json::to_string(&envelope).unwrap()
}

/// The `snapshot_stash_external` case: the envelope a session snapshot records for a stash on
/// local files.
async fn snapshot_stash_external() -> String {
    use strands::session::SessionManager;
    use strands::storage::{InMemoryStorage, LocalFileStorage, Storage};

    let dir = tempfile::tempdir().unwrap();
    let mut agent = conformance_agent_with(
        no_retrieval_tool(Some(Arc::new(LocalFileStorage::new(dir.path())))),
        None,
    );
    agent.invoke("What is the weather in Seattle?").await.unwrap();
    let storage = Arc::new(InMemoryStorage::new());
    let session = SessionManager::builder()
        .storage(storage.clone())
        .session_id("stash-external-session")
        .build()
        .unwrap();
    session.save_snapshot(agent.local(), true).await.unwrap();
    let bytes = storage
        .read("session/stash-external-session/scopes/agent/conformance-agent/snapshots/snapshot_latest.json")
        .await
        .unwrap()
        .unwrap();
    let snapshot: JsonValue = serde_json::from_slice(&bytes).unwrap();
    serde_json::to_string(&snapshot["data"]["stash"]).unwrap()
}

#[test]
fn metrics_round_trip_as_json() {
    let fixture = fixture("metrics");
    for case in &fixture.cases {
        round_trip::<JsonValue>("metrics", case);
    }
}

/// `weatherTool` of `generate.ts`.
fn weather_tool() -> FunctionTool {
    FunctionTool::builder("get_weather", "Get the weather for a city")
        .input_schema(json!({"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}))
        .stream_callback(|input: JsonValue, _| {
            let city = input["city"].clone();
            futures::stream::iter([
                Ok::<_, ToolError>(FunctionToolItem::Update(json!({"progress": "looking up"}))),
                Ok(FunctionToolItem::Return(
                    json!({"city": city, "forecast": "sunny", "high": 22}),
                )),
            ])
        })
}

/// `interruptingTool` of `generate.ts`.
fn interrupting_tool() -> FunctionTool {
    FunctionTool::builder("delete_files", "Delete files after confirmation")
        .input_schema(json!({"type": "object", "properties": {"path": {"type": "string"}}}))
        .callback(|input: JsonValue, context| async move {
            let params = InterruptParams::new("confirm_delete")
                .with_reason(json!({"message": "Delete these files?", "path": input["path"]}));
            let answer = context.interrupt(params)?;
            Ok(json!({"deleted": answer == "yes"}))
        })
}

/// `conformanceAgent` of `generate.ts`.
fn conformance_agent() -> Agent {
    let model = MockModel::new()
        .with_turn(
            MockTurn::content([
                ContentBlock::text("Let me check."),
                ToolUseBlock::new("get_weather", "tooluse-weather-1", json!({"city": "Seattle"})).into(),
            ])
            .with_usage(Usage::new(20, 10, 30)),
        )
        .with_turn(MockTurn::text("It is sunny in Seattle.").with_usage(Usage::new(40, 8, 48)));
    let app_state = json!({"units": "metric", "visits": 1});
    Agent::builder()
        .model(model)
        .tools([weather_tool()])
        .printer(false)
        .name("conformance_agent")
        .id("conformance-agent")
        .system_prompt("You are a weather assistant.")
        .app_state(app_state.as_object().unwrap().clone())
        .build()
        .unwrap()
}

/// `interruptAgent` of `generate.ts`.
fn interrupt_agent() -> Agent {
    let model = MockModel::new()
        .with_turn(MockTurn::content([
            ContentBlock::from(ToolUseBlock::new(
                "get_weather",
                "tooluse-weather-2",
                json!({"city": "Paris"}),
            )),
            ToolUseBlock::new("delete_files", "tooluse-delete-1", json!({"path": "/tmp/x"})).into(),
        ]))
        .with_turn("Deleted.");
    Agent::builder()
        .model(model)
        .tools([weather_tool(), interrupting_tool()])
        .printer(false)
        .name("interrupt_agent")
        .id("interrupt-agent")
        .build()
        .unwrap()
}

/// Replaces every `trackingId` (a random UUID in both SDKs) with a fixed value.
fn normalize_tracking_ids(value: &mut JsonValue) {
    match value {
        JsonValue::Object(map) => {
            for (key, entry) in map.iter_mut() {
                if key == "trackingId" {
                    *entry = json!("<tracking-id>");
                } else {
                    normalize_tracking_ids(entry);
                }
            }
        }
        JsonValue::Array(items) => items.iter_mut().for_each(normalize_tracking_ids),
        _ => {}
    }
}

fn normalized(json: &str) -> String {
    let mut value: JsonValue = serde_json::from_str(json).unwrap();
    normalize_tracking_ids(&mut value);
    serde_json::to_string(&value).unwrap()
}

fn snake_case(name: &str) -> String {
    let mut out = String::new();
    for (index, character) in name.chars().enumerate() {
        if character.is_ascii_uppercase() {
            if index > 0 {
                out.push('_');
            }
            out.push(character.to_ascii_lowercase());
        } else {
            out.push(character);
        }
    }
    out
}

/// `streamEventKey` of `generate.ts`: the record type, plus the model or tool event type and the
/// delta or start type.
fn stream_event_key(json: &JsonValue) -> String {
    let event = &json["event"];
    let detail = event["delta"]["type"]
        .as_str()
        .or_else(|| event["start"]["type"].as_str());
    [json["type"].as_str(), event["type"].as_str(), detail]
        .into_iter()
        .flatten()
        .map(snake_case)
        .collect::<Vec<_>>()
        .join("_")
}

async fn collect_stream(agent: &mut Agent, prompt: &str, seen: &mut IndexMap<String, String>) {
    let mut stream = agent.stream(prompt);
    while let Some(event) = stream.next().await {
        let json = serde_json::to_string(&event.unwrap()).unwrap();
        let key = stream_event_key(&serde_json::from_str(&json).unwrap());
        seen.entry(key).or_insert(json);
    }
}

/// The fixture cases `generate.ts` builds directly rather than from an agent run.
const DIRECT_STREAM_CASES: [&str; 5] = [
    "after_tool_call_event_error",
    "after_model_call_event_error",
    "after_model_call_event_redaction",
    "before_model_call_event_projected_input_tokens",
    "tool_stream_update_event_no_data",
];

#[tokio::test]
async fn agent_stream_events_match_a_rust_agent_run() {
    let mut seen = IndexMap::new();
    collect_stream(&mut conformance_agent(), "What is the weather in Seattle?", &mut seen).await;
    collect_stream(&mut interrupt_agent(), "Clean up /tmp/x", &mut seen).await;

    let fixture = fixture("agent_stream_events");
    let expected: IndexMap<&str, &str> = fixture
        .cases
        .iter()
        .filter(|case| !DIRECT_STREAM_CASES.contains(&case.name.as_str()))
        .map(|case| (case.name.as_str(), case.json.as_str()))
        .collect();
    let produced: Vec<&str> = seen.keys().map(String::as_str).collect();
    assert_eq!(produced, expected.keys().copied().collect::<Vec<_>>());
    for (name, json) in expected {
        assert_eq!(normalized(&seen[name]), normalized(json), "agent_stream_events/{name}");
    }
}

type Seen = Arc<Mutex<IndexMap<String, String>>>;

fn remember(seen: &Seen, name: &str, record: &impl Serialize) {
    let json = serde_json::to_string(record).unwrap();
    seen.lock().unwrap().entry(name.to_owned()).or_insert(json);
}

/// Registers a recording hook for every event, as the generator's `record` does.
fn record_hooks(agent: &Agent, seen: &Seen) {
    macro_rules! borrowing {
        ($($event:ident => $name:literal),* $(,)?) => {$(
            let slot = seen.clone();
            agent.add_hook(move |event: &mut $event<'_>| remember(&slot, $name, &AgentStreamEvent::from(&*event)));
        )*};
    }
    macro_rules! owned {
        ($($event:ident => $name:literal),* $(,)?) => {$(
            let slot = seen.clone();
            agent.add_hook(move |event: &mut $event| remember(&slot, $name, &AgentStreamEvent::from(&*event)));
        )*};
    }
    let slot = seen.clone();
    agent.add_hook(move |event: &mut InitializedEvent<'_>| {
        remember(&slot, "initialized_event", &InitializedEventData::from(&*event));
    });
    borrowing! {
        BeforeInvocationEvent => "before_invocation_event",
        AfterInvocationEvent => "after_invocation_event",
        MessageAddedEvent => "message_added_event",
        BeforeModelCallEvent => "before_model_call_event",
        AfterModelCallEvent => "after_model_call_event",
        ModelStreamUpdateEvent => "model_stream_update_event",
        ContentBlockEvent => "content_block_event",
        ModelMessageEvent => "model_message_event",
        AgentResultEvent => "agent_result_event",
        InterruptEvent => "interrupt_event",
        BeforeToolsEvent => "before_tools_event",
        AfterToolsEvent => "after_tools_event",
    }
    owned! {
        BeforeToolCallEvent => "before_tool_call_event",
        AfterToolCallEvent => "after_tool_call_event",
        ToolResultEvent => "tool_result_event",
        ToolStreamUpdateEvent => "tool_stream_update_event",
    }
}

#[tokio::test]
async fn hook_event_records_match_a_rust_agent_run() {
    let seen: Seen = Arc::default();
    let mut agent = conformance_agent();
    record_hooks(&agent, &seen);
    agent.invoke("What is the weather in Seattle?").await.unwrap();
    let mut interrupted = interrupt_agent();
    record_hooks(&interrupted, &seen);
    interrupted.invoke("Clean up /tmp/x").await.unwrap();

    let seen = seen.lock().unwrap();
    let fixture = fixture("hook_events");
    assert_eq!(seen.len(), fixture.cases.len(), "{:?}", seen.keys().collect::<Vec<_>>());
    for case in &fixture.cases {
        let produced = seen
            .get(&case.name)
            .unwrap_or_else(|| panic!("hook_events/{}: not observed", case.name));
        assert_eq!(
            normalized(produced),
            normalized(&case.json),
            "hook_events/{}",
            case.name
        );
    }
}

/// Records span names in creation order, with the `otel.name` override `tracing-opentelemetry`
/// exports them under.
#[derive(Clone, Default)]
struct SpanNames(Arc<Mutex<Vec<(tracing::span::Id, String)>>>);

struct OtelName(Option<String>);

impl tracing::field::Visit for OtelName {
    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        if field.name() == "otel.name" {
            self.0 = Some(value.to_owned());
        }
    }

    fn record_debug(&mut self, _field: &tracing::field::Field, _value: &dyn std::fmt::Debug) {}
}

impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for SpanNames {
    fn on_new_span(
        &self,
        attrs: &tracing::span::Attributes<'_>,
        id: &tracing::span::Id,
        _ctx: tracing_subscriber::layer::Context<'_, S>,
    ) {
        let mut name = OtelName(None);
        attrs.record(&mut name);
        let name = name.0.unwrap_or_else(|| attrs.metadata().name().to_owned());
        self.0.lock().unwrap().push((id.clone(), name));
    }

    fn on_record(
        &self,
        id: &tracing::span::Id,
        values: &tracing::span::Record<'_>,
        _ctx: tracing_subscriber::layer::Context<'_, S>,
    ) {
        let mut name = OtelName(None);
        values.record(&mut name);
        let Some(name) = name.0 else {
            return;
        };
        for (span, recorded) in self.0.lock().unwrap().iter_mut() {
            if span == id {
                recorded.clone_from(&name);
            }
        }
    }
}

#[tokio::test]
async fn span_names_match_a_rust_agent_run() {
    use tracing_subscriber::layer::SubscriberExt;

    static KEEP_INTEREST: std::sync::LazyLock<tracing::Dispatch> =
        std::sync::LazyLock::new(|| tracing::Dispatch::new(tracing_subscriber::registry()));
    std::sync::LazyLock::force(&KEEP_INTEREST);
    let names = SpanNames::default();
    let subscriber = tracing_subscriber::registry().with(names.clone());
    let _guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();
    conformance_agent()
        .invoke("What is the weather in Seattle?")
        .await
        .unwrap();
    let mut unique: Vec<String> = Vec::new();
    for (_, name) in names.0.lock().unwrap().iter() {
        if !unique.contains(name) {
            unique.push(name.clone());
        }
    }
    let fixture = fixture("metrics");
    let case = fixture.cases.iter().find(|case| case.name == "span_names").unwrap();
    assert_eq!(json!(unique), serde_json::from_str::<JsonValue>(&case.json).unwrap());
}
