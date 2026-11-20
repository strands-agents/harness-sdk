use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use futures::StreamExt;
use serde_json::{Value, json};

use super::*;
use crate::error::{Error, Result};
use crate::injection::tests::model_context;
use crate::middleware::InvokeModelStage;
use crate::test_support::{MockTool, local_agent, record_logs};
use crate::testing::{MockModel, tool_context};
use crate::tools::{Tool, ToolOutcome, ToolSource, ToolStreamItem};
use crate::types::{
    ContentBlock, JsonObject, JsonValue, Message, Role, ToolResultBlock, ToolResultContent, ToolResultStatus, ToolUse,
    ToolUseBlock,
};
use crate::{Agent, Plugin};

/// A scripted store: records its calls.
#[derive(Default)]
pub(crate) struct MockStore {
    pub(crate) name: String,
    pub(crate) writable: bool,
    pub(crate) description: Option<String>,
    pub(crate) max_search_results: Option<usize>,
    pub(crate) entries: Vec<MemoryEntry>,
    pub(crate) search_error: Option<String>,
    pub(crate) has_add: bool,
    pub(crate) has_add_messages: bool,
    pub(crate) add_error: Mutex<Option<String>>,
    pub(crate) add_messages_error: Mutex<Option<String>>,
    pub(crate) add_messages_gate: Option<Arc<tokio::sync::Semaphore>>,
    /// Per-call outcomes for `add` and `add_messages`, taken in order before the static errors.
    pub(crate) add_script: Mutex<std::collections::VecDeque<Option<String>>>,
    pub(crate) add_messages_script: Mutex<std::collections::VecDeque<Option<String>>>,
    pub(crate) extraction: Option<ExtractionConfig>,
    pub(crate) tools: Vec<&'static str>,
    pub(crate) searches: Mutex<Vec<(String, SearchOptions)>>,
    pub(crate) adds: Mutex<Vec<(String, Option<JsonObject>)>>,
    pub(crate) batches: Mutex<Vec<(Vec<Message>, AddMessagesContext)>>,
}

impl MockStore {
    pub(crate) fn new(name: &str) -> Self {
        Self {
            name: name.to_owned(),
            ..Self::default()
        }
    }

    pub(crate) fn writable(mut self) -> Self {
        self.writable = true;
        self.has_add = true;
        self
    }

    pub(crate) fn with_entries(mut self, entries: &[&str]) -> Self {
        self.entries = entries.iter().map(|content| MemoryEntry::new(*content)).collect();
        self
    }

    pub(crate) fn with_description(mut self, description: &str) -> Self {
        self.description = Some(description.to_owned());
        self
    }

    pub(crate) fn failing_adds(self, reason: &str) -> Self {
        *self.add_error.lock().unwrap() = Some(reason.to_owned());
        self
    }

    pub(crate) fn search_count(&self) -> usize {
        self.searches.lock().unwrap().len()
    }

    pub(crate) fn add_calls(&self) -> Vec<(String, Option<JsonObject>)> {
        self.adds.lock().unwrap().clone()
    }

    pub(crate) fn batches(&self) -> Vec<(Vec<Message>, AddMessagesContext)> {
        self.batches.lock().unwrap().clone()
    }
}

#[async_trait]
impl MemoryStore for MockStore {
    fn name(&self) -> &str {
        &self.name
    }

    fn description(&self) -> Option<&str> {
        self.description.as_deref()
    }

    fn max_search_results(&self) -> Option<usize> {
        self.max_search_results
    }

    fn writable(&self) -> bool {
        self.writable
    }

    fn extraction(&self) -> Option<ExtractionConfig> {
        self.extraction.clone()
    }

    async fn search(&self, query: &str, options: SearchOptions) -> Result<Vec<MemoryEntry>> {
        self.searches.lock().unwrap().push((query.to_owned(), options));
        if let Some(reason) = &self.search_error {
            return Err(Error::other(reason.clone()));
        }
        Ok(self.entries.clone())
    }

    fn implements_add(&self) -> bool {
        self.has_add
    }

    async fn add(&self, content: &str, metadata: Option<JsonObject>) -> Result<JsonValue> {
        self.adds.lock().unwrap().push((content.to_owned(), metadata));
        let scripted = self.add_script.lock().unwrap().pop_front();
        let error = scripted.unwrap_or_else(|| self.add_error.lock().unwrap().clone());
        match error {
            Some(reason) => Err(Error::other(reason)),
            None => Ok(JsonValue::Null),
        }
    }

    fn implements_add_messages(&self) -> bool {
        self.has_add_messages
    }

    async fn add_messages(&self, messages: &[Message], context: AddMessagesContext) -> Result<JsonValue> {
        self.batches.lock().unwrap().push((messages.to_vec(), context));
        if let Some(gate) = &self.add_messages_gate {
            drop(gate.acquire().await);
        }
        let scripted = self.add_messages_script.lock().unwrap().pop_front();
        let error = scripted.unwrap_or_else(|| self.add_messages_error.lock().unwrap().clone());
        match error {
            Some(reason) => Err(Error::other(reason)),
            None => Ok(JsonValue::Null),
        }
    }

    fn get_tools(&self) -> Vec<ToolSource> {
        self.tools.iter().map(|name| MockTool::new(name).into()).collect()
    }
}

fn manager(stores: Vec<Arc<MockStore>>) -> MemoryManagerConfig {
    MemoryManagerConfig {
        stores: stores.into_iter().map(|store| store as Arc<dyn MemoryStore>).collect(),
        ..Default::default()
    }
}

fn store(name: &str) -> Arc<MockStore> {
    Arc::new(MockStore::new(name))
}

fn writable(name: &str) -> Arc<MockStore> {
    Arc::new(MockStore::new(name).writable())
}

fn error_text(config: MemoryManagerConfig) -> String {
    MemoryManager::new(config).unwrap_err().to_string()
}

fn tool_names(manager: &MemoryManager) -> Vec<String> {
    manager
        .get_tools()
        .into_iter()
        .flat_map(ToolSource::into_tools)
        .map(|tool| tool.name().to_owned())
        .collect()
}

fn find_tool(manager: &MemoryManager, name: &str) -> Arc<dyn Tool> {
    manager
        .get_tools()
        .into_iter()
        .flat_map(ToolSource::into_tools)
        .find(|tool| tool.name() == name)
        .unwrap()
}

/// Runs a tool and returns its result (`tool.invoke`).
pub(crate) async fn invoke(tool: &Arc<dyn Tool>, input: Value) -> ToolResultBlock {
    let mut stream = tool.stream(tool_context(ToolUse::new(tool.name(), "t-1", input)));
    let mut result = None;
    while let Some(item) = stream.next().await {
        if let ToolStreamItem::Outcome(ToolOutcome::Result(block)) = item {
            result = Some(block);
        }
    }
    result.unwrap()
}

fn json_content(result: &ToolResultBlock) -> Value {
    assert_eq!(result.status, ToolResultStatus::Success, "{:?}", result.content);
    match &result.content[0] {
        ToolResultContent::Json(block) => block.json.clone(),
        other => panic!("not json: {other:?}"),
    }
}

fn error_message(result: &ToolResultBlock) -> String {
    assert_eq!(result.status, ToolResultStatus::Error);
    match &result.content[0] {
        ToolResultContent::Text(text) => text.text.clone(),
        other => panic!("not text: {other:?}"),
    }
}

fn entry(content: &str, store: &str) -> MemoryEntry {
    MemoryEntry::new(content).with_store_name(store)
}

fn tool_use_message() -> Message {
    Message::new(Role::Assistant, vec![ToolUseBlock::new("x", "t1", json!({})).into()])
}

fn tool_result_message() -> Message {
    Message::new(
        Role::User,
        vec![ContentBlock::ToolResult(ToolResultBlock::success(
            "t1",
            vec![ToolResultContent::text("done")],
        ))],
    )
}

// --- constructor -------------------------------------------------------------------------------

#[test]
fn throws_when_stores_array_is_empty() {
    assert_eq!(
        error_text(MemoryManagerConfig::default()),
        "MemoryManager: at least one store is required"
    );
}

#[test]
fn creates_instance_with_valid_config() {
    let manager = MemoryManager::new(manager(vec![store("test")])).unwrap();
    assert_eq!(manager.name(), "strands:memory-manager");
}

#[test]
fn throws_when_two_stores_share_a_name() {
    assert_eq!(
        error_text(manager(vec![store("dup"), store("dup")])),
        "MemoryManager: duplicate store name 'dup'"
    );
}

#[test]
fn throws_when_a_store_is_writable_but_has_no_add_method() {
    let broken = Arc::new(MockStore {
        writable: true,
        ..MockStore::new("broken")
    });
    assert_eq!(
        error_text(manager(vec![broken])),
        "MemoryManager: store 'broken' is writable but has no add or addMessages method"
    );
}

#[test]
fn throws_when_add_tool_config_is_enabled_but_no_stores_are_writable() {
    let config = MemoryManagerConfig {
        add_tool_config: Some(true.into()),
        ..manager(vec![store("a")])
    };
    assert_eq!(
        error_text(config),
        "MemoryManager: addToolConfig is enabled but no writable stores implement add"
    );
}

#[test]
fn allows_add_tool_config_true_with_a_single_writable_store() {
    let config = MemoryManagerConfig {
        add_tool_config: Some(true.into()),
        ..manager(vec![writable("a")])
    };
    assert!(tool_names(&MemoryManager::new(config).unwrap()).contains(&"add_memory".to_owned()));
}

#[test]
fn allows_add_tool_config_true_with_multiple_writable_stores() {
    let config = MemoryManagerConfig {
        add_tool_config: Some(true.into()),
        ..manager(vec![writable("a"), writable("b")])
    };
    assert!(tool_names(&MemoryManager::new(config).unwrap()).contains(&"add_memory".to_owned()));
}

fn add_tool_stores(stores: &[&str]) -> Option<Toggle<MemoryAddToolConfig>> {
    Some(
        MemoryAddToolConfig {
            stores: Some(stores.iter().map(|name| (*name).to_owned()).collect()),
            ..Default::default()
        }
        .into(),
    )
}

#[test]
fn throws_when_add_tool_config_stores_names_a_non_existent_store() {
    let config = MemoryManagerConfig {
        add_tool_config: add_tool_stores(&["nonexistent"]),
        ..manager(vec![writable("a")])
    };
    assert_eq!(
        error_text(config),
        "MemoryManager: addToolConfig store 'nonexistent' not found"
    );
}

#[test]
fn throws_when_add_tool_config_stores_names_a_non_writable_store() {
    let config = MemoryManagerConfig {
        add_tool_config: add_tool_stores(&["readonly"]),
        ..manager(vec![writable("a"), store("readonly")])
    };
    assert_eq!(
        error_text(config),
        "MemoryManager: addToolConfig store 'readonly' is not writable"
    );
}

#[tokio::test]
async fn accepts_memory_store_instances_not_just_names_in_add_tool_config_stores() {
    let personal = writable("personal");
    let team = writable("team");
    let config = MemoryManagerConfig {
        add_tool_config: add_tool_stores(&[personal.name()]),
        ..manager(vec![personal.clone(), team.clone()])
    };
    let manager = MemoryManager::new(config).unwrap();
    invoke(&find_tool(&manager, "add_memory"), json!({"entries": ["fact"]})).await;
    assert_eq!(personal.add_calls(), [("fact".to_owned(), None)]);
    assert!(team.add_calls().is_empty());
}

#[test]
fn throws_when_an_add_tool_config_stores_instance_is_not_a_configured_store() {
    let stray = writable("stray");
    let config = MemoryManagerConfig {
        add_tool_config: add_tool_stores(&[stray.name()]),
        ..manager(vec![writable("configured")])
    };
    assert_eq!(
        error_text(config),
        "MemoryManager: addToolConfig store 'stray' not found"
    );
}

// --- getTools ----------------------------------------------------------------------------------

#[test]
fn registers_search_tool_by_default() {
    let manager = MemoryManager::new(manager(vec![store("test")])).unwrap();
    assert_eq!(tool_names(&manager), ["search_memory"]);
}

#[test]
fn registers_add_tool_when_add_tool_config_is_enabled() {
    let config = MemoryManagerConfig {
        add_tool_config: Some(true.into()),
        ..manager(vec![writable("test")])
    };
    assert_eq!(
        tool_names(&MemoryManager::new(config).unwrap()),
        ["search_memory", "add_memory"]
    );
}

#[test]
fn does_not_register_add_tool_by_default() {
    let manager = MemoryManager::new(manager(vec![writable("test")])).unwrap();
    assert_eq!(tool_names(&manager), ["search_memory"]);
}

#[test]
fn returns_empty_array_when_search_tool_config_is_false_and_add_tool_config_is_false() {
    let config = MemoryManagerConfig {
        search_tool_config: Some(false.into()),
        add_tool_config: Some(false.into()),
        ..manager(vec![writable("test")])
    };
    assert!(tool_names(&MemoryManager::new(config).unwrap()).is_empty());
}

#[test]
fn uses_custom_tool_names_from_memory_tool_config() {
    let config = MemoryManagerConfig {
        search_tool_config: Some(MemoryToolConfig::builder().name("recall").build().into()),
        add_tool_config: Some(MemoryAddToolConfig::builder().name("remember").build().into()),
        ..manager(vec![writable("test")])
    };
    assert_eq!(tool_names(&MemoryManager::new(config).unwrap()), ["recall", "remember"]);
}

#[test]
fn includes_store_descriptions_in_search_tool_description() {
    let personal = Arc::new(MockStore::new("personal").with_description("User preferences"));
    let manager = MemoryManager::new(manager(vec![personal])).unwrap();
    let description = find_tool(&manager, "search_memory").description().to_owned();
    assert!(description.contains("personal: User preferences"));
    assert!(description.contains("target one or more memory stores by name"));
}

#[test]
fn includes_store_descriptions_in_add_tool_description() {
    let notes = Arc::new(MockStore::new("notes").writable().with_description("Personal notes"));
    let config = MemoryManagerConfig {
        add_tool_config: Some(true.into()),
        ..manager(vec![notes])
    };
    let manager = MemoryManager::new(config).unwrap();
    let description = find_tool(&manager, "add_memory").description().to_owned();
    assert!(description.contains("notes: Personal notes"));
    assert!(description.contains("target a specific store by name"));
}

#[test]
fn aggregates_tools_provided_by_stores_via_get_tools() {
    let kb = Arc::new(MockStore {
        tools: vec!["kb_query"],
        ..MockStore::new("kb")
    });
    assert_eq!(
        tool_names(&MemoryManager::new(manager(vec![kb])).unwrap()),
        ["search_memory", "kb_query"]
    );
}

#[test]
fn aggregates_store_tools_across_multiple_stores_alongside_the_manager_tools() {
    let a = Arc::new(MockStore {
        tools: vec!["a_tool"],
        ..MockStore::new("a").writable()
    });
    let b = Arc::new(MockStore {
        tools: vec!["b_tool"],
        ..MockStore::new("b")
    });
    let config = MemoryManagerConfig {
        add_tool_config: Some(true.into()),
        ..manager(vec![a, b])
    };
    assert_eq!(
        tool_names(&MemoryManager::new(config).unwrap()),
        ["search_memory", "add_memory", "a_tool", "b_tool"]
    );
}

#[test]
fn includes_store_tools_even_when_the_manager_registers_no_tools_of_its_own() {
    let kb = Arc::new(MockStore {
        tools: vec!["kb_query"],
        ..MockStore::new("kb")
    });
    let config = MemoryManagerConfig {
        search_tool_config: Some(false.into()),
        ..manager(vec![kb])
    };
    assert_eq!(tool_names(&MemoryManager::new(config).unwrap()), ["kb_query"]);
}

#[test]
fn the_tool_schemas_match_the_ts_zod_schemas() {
    let config = MemoryManagerConfig {
        add_tool_config: Some(true.into()),
        ..manager(vec![writable("test")])
    };
    let manager = MemoryManager::new(config).unwrap();
    assert_eq!(
        serde_json::to_string(&find_tool(&manager, "search_memory").tool_spec().input_schema).unwrap(),
        r#"{"type":"object","properties":{"query":{"type":"string","description":"What to search for"},"maxSearchResults":{"description":"Maximum number of results per store","type":"number"},"stores":{"description":"Filter to specific stores by name. Omit to search all available stores.","type":"array","items":{"type":"string"}}},"required":["query"],"additionalProperties":false}"#
    );
    assert_eq!(
        serde_json::to_string(&find_tool(&manager, "add_memory").tool_spec().input_schema).unwrap(),
        r#"{"type":"object","properties":{"entries":{"minItems":1,"type":"array","items":{"type":"string"},"description":"Data to add to long-term memory"},"stores":{"description":"Target specific stores by name. Omit to add to all writable stores.","type":"array","items":{"type":"string"}}},"required":["entries"],"additionalProperties":false}"#
    );
}

// --- search ------------------------------------------------------------------------------------

fn searchable(name: &str, entries: &[&str]) -> Arc<MockStore> {
    Arc::new(MockStore::new(name).with_entries(entries))
}

#[tokio::test]
async fn queries_all_stores_and_concatenates_results() {
    let manager = MemoryManager::new(manager(vec![
        searchable("a", &["fact one"]),
        searchable("b", &["fact two"]),
    ]))
    .unwrap();
    let results = manager
        .search_with("query", MemorySearchOptions::default())
        .await
        .unwrap();
    assert_eq!(results, [entry("fact one", "a"), entry("fact two", "b")]);
}

#[tokio::test]
async fn resolves_a_stores_per_instance_max_search_results_when_the_caller_omits_it() {
    let a = Arc::new(MockStore {
        max_search_results: Some(5),
        ..MockStore::new("a")
    });
    let manager = MemoryManager::new(manager(vec![a.clone()])).unwrap();
    manager
        .search_with("query", MemorySearchOptions::default())
        .await
        .unwrap();
    assert_eq!(a.searches.lock().unwrap()[0].1.max_search_results, Some(5));
}

#[tokio::test]
async fn forwards_an_explicit_max_search_results_override_to_each_store() {
    let a = Arc::new(MockStore {
        max_search_results: Some(5),
        ..MockStore::new("a")
    });
    let manager = MemoryManager::new(manager(vec![a.clone()])).unwrap();
    let options = MemorySearchOptions {
        max_search_results: Some(2),
        stores: None,
    };
    manager.search_with("query", options).await.unwrap();
    assert_eq!(a.searches.lock().unwrap()[0].1.max_search_results, Some(2));
}

#[tokio::test]
async fn falls_back_to_the_sdk_default_when_neither_caller_nor_store_specifies_a_limit() {
    let a = store("a");
    let manager = MemoryManager::new(manager(vec![a.clone()])).unwrap();
    manager
        .search_with("query", MemorySearchOptions::default())
        .await
        .unwrap();
    assert_eq!(
        *a.searches.lock().unwrap(),
        [(
            "query".to_owned(),
            SearchOptions {
                max_search_results: Some(3)
            }
        )]
    );
}

fn only(stores: &[&str]) -> MemorySearchOptions {
    MemorySearchOptions {
        max_search_results: None,
        stores: Some(stores.iter().map(|name| (*name).to_owned()).collect()),
    }
}

#[tokio::test]
async fn filters_to_named_stores_when_options_stores_is_provided() {
    let personal = searchable("personal", &["personal fact"]);
    let team = searchable("team", &["team fact"]);
    let manager = MemoryManager::new(manager(vec![personal, team.clone()])).unwrap();
    let results = manager.search_with("query", only(&["personal"])).await.unwrap();
    assert_eq!(results, [entry("personal fact", "personal")]);
    assert_eq!(team.search_count(), 0);
}

#[tokio::test]
async fn gracefully_handles_store_failures() {
    let failing = Arc::new(MockStore {
        search_error: Some("network error".into()),
        ..MockStore::new("failing")
    });
    let manager = MemoryManager::new(manager(vec![failing, searchable("ok", &["fact"])])).unwrap();
    let results = manager
        .search_with("query", MemorySearchOptions::default())
        .await
        .unwrap();
    assert_eq!(results, [entry("fact", "ok")]);
}

#[tokio::test]
async fn searches_all_stores_when_stores_option_is_omitted() {
    let manager = MemoryManager::new(manager(vec![
        searchable("a", &["fact one"]),
        searchable("b", &["fact two"]),
    ]))
    .unwrap();
    let results = manager
        .search_with("query", MemorySearchOptions::default())
        .await
        .unwrap();
    assert_eq!(results.len(), 2);
}

#[tokio::test]
async fn searches_no_stores_when_stores_option_is_an_empty_array() {
    let a = searchable("a", &["fact one"]);
    let b = searchable("b", &["fact two"]);
    let manager = MemoryManager::new(manager(vec![a.clone(), b.clone()])).unwrap();
    assert!(manager.search_with("query", only(&[])).await.unwrap().is_empty());
    assert_eq!(a.search_count() + b.search_count(), 0);
}

#[tokio::test]
async fn throws_a_not_found_error_when_a_named_store_does_not_exist() {
    let personal = searchable("personal", &["fact"]);
    let manager = MemoryManager::new(manager(vec![personal.clone()])).unwrap();
    let error = manager.search_with("query", only(&["nonexistent"])).await.unwrap_err();
    assert_eq!(error.to_string(), "MemoryManager: store 'nonexistent' not found");
    assert_eq!(personal.search_count(), 0);
}

// --- add ---------------------------------------------------------------------------------------

fn to(stores: &[&str]) -> MemoryAddOptions {
    MemoryAddOptions {
        metadata: None,
        stores: Some(stores.iter().map(|name| (*name).to_owned()).collect()),
    }
}

#[tokio::test]
async fn writes_to_all_writable_stores() {
    let a = writable("a");
    let b = writable("b");
    let manager = MemoryManager::new(manager(vec![a.clone(), b.clone()])).unwrap();
    manager
        .add_with("user likes coffee", MemoryAddOptions::default())
        .await
        .unwrap();
    assert_eq!(a.add_calls(), [("user likes coffee".to_owned(), None)]);
    assert_eq!(b.add_calls(), [("user likes coffee".to_owned(), None)]);
}

#[tokio::test]
async fn passes_metadata_to_stores() {
    let a = writable("a");
    let manager = MemoryManager::new(manager(vec![a.clone()])).unwrap();
    let metadata = json!({"source": "user"}).as_object().cloned();
    let options = MemoryAddOptions {
        metadata: metadata.clone(),
        stores: None,
    };
    manager.add_with("fact", options).await.unwrap();
    assert_eq!(a.add_calls(), [("fact".to_owned(), metadata)]);
}

#[tokio::test]
async fn filters_add_to_named_stores_when_options_stores_is_provided() {
    let personal = writable("personal");
    let team = writable("team");
    let manager = MemoryManager::new(manager(vec![personal.clone(), team.clone()])).unwrap();
    manager.add_with("my preference", to(&["personal"])).await.unwrap();
    assert_eq!(personal.add_calls(), [("my preference".to_owned(), None)]);
    assert!(team.add_calls().is_empty());
}

#[tokio::test]
async fn dedupes_duplicate_store_names_so_each_store_is_written_once() {
    let personal = writable("personal");
    let manager = MemoryManager::new(manager(vec![personal.clone()])).unwrap();
    manager.add_with("fact", to(&["personal", "personal"])).await.unwrap();
    assert_eq!(personal.add_calls().len(), 1);
}

#[tokio::test]
async fn throws_when_no_writable_stores_match() {
    let manager = MemoryManager::new(manager(vec![store("a")])).unwrap();
    let error = manager.add_with("fact", MemoryAddOptions::default()).await.unwrap_err();
    assert_eq!(error.to_string(), "MemoryManager: no writable store matched");
}

#[tokio::test]
async fn throws_a_not_found_error_when_a_named_add_store_does_not_exist() {
    let manager = MemoryManager::new(manager(vec![writable("a")])).unwrap();
    let error = manager.add_with("fact", to(&["nonexistent"])).await.unwrap_err();
    assert_eq!(error.to_string(), "MemoryManager: store 'nonexistent' not found");
}

#[tokio::test]
async fn throws_a_read_only_error_when_a_named_store_cannot_be_written() {
    let manager = MemoryManager::new(manager(vec![store("readonly")])).unwrap();
    let error = manager.add_with("fact", to(&["readonly"])).await.unwrap_err();
    assert_eq!(error.to_string(), "MemoryManager: store 'readonly' is read-only");
}

#[tokio::test]
async fn awaits_writes_and_throws_aggregate_error_naming_the_failed_store_on_partial_failure() {
    let failing = Arc::new(MockStore::new("failing").writable().failing_adds("write error"));
    let ok = writable("ok");
    let manager = MemoryManager::new(manager(vec![failing, ok.clone()])).unwrap();
    let error = manager.add_with("fact", MemoryAddOptions::default()).await.unwrap_err();
    assert_eq!(error.to_string(), "MemoryManager: store writes failed: failing");
    assert_eq!(ok.add_calls(), [("fact".to_owned(), None)]);
}

#[tokio::test]
async fn dispatches_writes_to_all_targeted_stores() {
    let a = writable("a");
    let b = writable("b");
    let manager = MemoryManager::new(manager(vec![a.clone(), b.clone()])).unwrap();
    manager.add_with("fact", MemoryAddOptions::default()).await.unwrap();
    assert_eq!(a.add_calls().len() + b.add_calls().len(), 2);
}

// --- tool store scoping ------------------------------------------------------------------------

fn with_add_tool(stores: Vec<Arc<MockStore>>, add_tool_config: Toggle<MemoryAddToolConfig>) -> MemoryManager {
    MemoryManager::new(MemoryManagerConfig {
        add_tool_config: Some(add_tool_config),
        ..manager(stores)
    })
    .unwrap()
}

#[tokio::test]
async fn search_tool_queries_all_stores_when_model_omits_stores() {
    let personal = searchable("personal", &["personal fact"]);
    let team = searchable("team", &["team fact"]);
    let manager = MemoryManager::new(manager(vec![personal.clone(), team.clone()])).unwrap();
    invoke(&find_tool(&manager, "search_memory"), json!({"query": "q"})).await;
    assert_eq!((personal.search_count(), team.search_count()), (1, 1));
}

#[tokio::test]
async fn search_tool_treats_an_empty_stores_array_as_omitted_searches_all() {
    let personal = searchable("personal", &["personal fact"]);
    let team = searchable("team", &["team fact"]);
    let manager = MemoryManager::new(manager(vec![personal.clone(), team.clone()])).unwrap();
    invoke(
        &find_tool(&manager, "search_memory"),
        json!({"query": "q", "stores": []}),
    )
    .await;
    assert_eq!((personal.search_count(), team.search_count()), (1, 1));
}

#[tokio::test]
async fn search_tool_targets_only_the_requested_store_when_in_scope() {
    let personal = searchable("personal", &["personal fact"]);
    let team = searchable("team", &["team fact"]);
    let manager = MemoryManager::new(manager(vec![personal.clone(), team.clone()])).unwrap();
    invoke(
        &find_tool(&manager, "search_memory"),
        json!({"query": "q", "stores": ["personal"]}),
    )
    .await;
    assert_eq!((personal.search_count(), team.search_count()), (1, 0));
}

#[tokio::test]
async fn search_tool_result_attributes_each_entry_to_its_source_store() {
    let manager = MemoryManager::new(manager(vec![
        searchable("personal", &["personal fact"]),
        searchable("team", &["team fact"]),
    ]))
    .unwrap();
    let result = invoke(&find_tool(&manager, "search_memory"), json!({"query": "q"})).await;
    assert_eq!(
        json_content(&result),
        json!({"$value": [
            {"content": "personal fact", "storeName": "personal"},
            {"content": "team fact", "storeName": "team"}
        ]})
    );
}

#[tokio::test]
async fn search_tool_keeps_valid_names_and_warns_on_out_of_scope_names() {
    let (logs, _guard) = record_logs();
    let personal = searchable("personal", &["personal fact"]);
    let team = searchable("team", &["team fact"]);
    let manager = MemoryManager::new(manager(vec![personal.clone(), team.clone()])).unwrap();
    invoke(
        &find_tool(&manager, "search_memory"),
        json!({"query": "q", "stores": ["personal", "nonexistent"]}),
    )
    .await;
    assert_eq!((personal.search_count(), team.search_count()), (1, 0));
    assert!(
        logs.text()
            .contains("requested=<nonexistent> | ignoring memory stores outside this tool's scope")
    );
}

#[tokio::test]
async fn search_tool_throws_when_every_requested_store_is_out_of_scope() {
    let personal = searchable("personal", &["personal fact"]);
    let manager = MemoryManager::new(manager(vec![personal.clone()])).unwrap();
    let result = invoke(
        &find_tool(&manager, "search_memory"),
        json!({"query": "q", "stores": ["nonexistent"]}),
    )
    .await;
    assert_eq!(
        error_message(&result),
        "Error: MemoryManager: requested=<nonexistent> | none of the requested memory stores are available; available stores: personal"
    );
    assert_eq!(personal.search_count(), 0);
}

#[tokio::test]
async fn add_tool_writes_to_all_writable_stores_when_model_omits_stores() {
    let personal = writable("personal");
    let team = writable("team");
    let manager = with_add_tool(vec![personal.clone(), team.clone()], true.into());
    invoke(&find_tool(&manager, "add_memory"), json!({"entries": ["fact"]})).await;
    assert_eq!(personal.add_calls(), [("fact".to_owned(), None)]);
    assert_eq!(team.add_calls(), [("fact".to_owned(), None)]);
}

#[tokio::test]
async fn add_tool_treats_an_empty_stores_array_as_omitted_writes_to_all_writable() {
    let personal = writable("personal");
    let team = writable("team");
    let manager = with_add_tool(vec![personal.clone(), team.clone()], true.into());
    invoke(
        &find_tool(&manager, "add_memory"),
        json!({"entries": ["fact"], "stores": []}),
    )
    .await;
    assert_eq!((personal.add_calls().len(), team.add_calls().len()), (1, 1));
}

#[tokio::test]
async fn add_tool_is_scoped_to_add_tool_config_stores_excludes_other_writable_stores() {
    let personal = writable("personal");
    let team = writable("team");
    let manager = with_add_tool(
        vec![personal.clone(), team.clone()],
        add_tool_stores(&["personal"]).unwrap(),
    );
    invoke(&find_tool(&manager, "add_memory"), json!({"entries": ["fact"]})).await;
    assert_eq!(personal.add_calls(), [("fact".to_owned(), None)]);
    assert!(team.add_calls().is_empty());
}

#[tokio::test]
async fn add_tool_rejects_a_writable_store_excluded_from_add_tool_config_stores_extraction_only_store() {
    let personal = writable("personal");
    let extraction_only = writable("extraction-only");
    let manager = with_add_tool(
        vec![personal, extraction_only.clone()],
        add_tool_stores(&["personal"]).unwrap(),
    );
    let result = invoke(
        &find_tool(&manager, "add_memory"),
        json!({"entries": ["fact"], "stores": ["extraction-only"]}),
    )
    .await;
    assert!(error_message(&result).contains("none of the requested memory stores are available"));
    assert!(extraction_only.add_calls().is_empty());
}

#[tokio::test]
async fn add_tool_excludes_read_only_stores_from_its_scope() {
    let personal = writable("personal");
    let manager = with_add_tool(vec![personal.clone(), store("readonly")], true.into());
    let result = invoke(
        &find_tool(&manager, "add_memory"),
        json!({"entries": ["fact"], "stores": ["readonly"]}),
    )
    .await;
    assert!(error_message(&result).contains("none of the requested memory stores are available"));
    assert!(personal.add_calls().is_empty());
}

#[tokio::test]
async fn add_tool_keeps_valid_names_and_warns_on_out_of_scope_names() {
    let (logs, _guard) = record_logs();
    let personal = writable("personal");
    let team = writable("team");
    let manager = with_add_tool(vec![personal.clone(), team.clone()], true.into());
    invoke(
        &find_tool(&manager, "add_memory"),
        json!({"entries": ["fact"], "stores": ["personal", "nonexistent"]}),
    )
    .await;
    assert_eq!(personal.add_calls(), [("fact".to_owned(), None)]);
    assert!(team.add_calls().is_empty());
    assert!(logs.text().contains("requested=<nonexistent>"));
}

#[tokio::test]
async fn add_tool_throws_when_every_requested_store_is_out_of_scope() {
    let personal = writable("personal");
    let manager = with_add_tool(vec![personal.clone()], true.into());
    let result = invoke(
        &find_tool(&manager, "add_memory"),
        json!({"entries": ["fact"], "stores": ["nonexistent"]}),
    )
    .await;
    assert!(error_message(&result).contains("none of the requested memory stores are available"));
    assert!(personal.add_calls().is_empty());
}

#[tokio::test]
async fn add_tool_rejects_an_empty_entries_array() {
    let personal = writable("personal");
    let manager = with_add_tool(vec![personal.clone()], true.into());
    let result = invoke(&find_tool(&manager, "add_memory"), json!({"entries": []})).await;
    assert_eq!(result.status, ToolResultStatus::Error);
    assert!(personal.add_calls().is_empty());
}

#[tokio::test]
async fn add_tool_returns_stored_count_by_default_awaits_writes() {
    let manager = with_add_tool(vec![writable("notes")], true.into());
    let result = invoke(&find_tool(&manager, "add_memory"), json!({"entries": ["a", "b"]})).await;
    assert_eq!(json_content(&result), json!({"stored": 2}));
}

#[tokio::test]
async fn add_tool_throws_a_flattened_error_with_concrete_reasons_when_entries_fail_default_awaits() {
    let failing = Arc::new(MockStore::new("failing").writable().failing_adds("write error"));
    let manager = with_add_tool(vec![failing], true.into());
    let result = invoke(&find_tool(&manager, "add_memory"), json!({"entries": ["a", "b"]})).await;
    let message = error_message(&result);
    assert!(message.contains("failed to add 2 of 2 entries"));
    assert!(message.contains("write error"));
    let error = result.error.as_ref().unwrap();
    let aggregate = error.downcast_ref::<AggregateError>().unwrap();
    assert_eq!(aggregate.errors().len(), 2);
    assert!(
        aggregate
            .errors()
            .iter()
            .all(|error| error.to_string() == "write error")
    );
}

#[tokio::test]
async fn add_tool_with_wait_for_writes_false_returns_accepted_count_fire_and_forget() {
    let manager = with_add_tool(
        vec![writable("notes")],
        MemoryAddToolConfig::builder().wait_for_writes(false).build().into(),
    );
    let result = invoke(&find_tool(&manager, "add_memory"), json!({"entries": ["a", "b"]})).await;
    assert_eq!(json_content(&result), json!({"accepted": 2}));
}

#[tokio::test]
async fn add_tool_with_wait_for_writes_false_returns_accepted_even_when_a_store_write_fails_swallows_it() {
    let failing = Arc::new(MockStore::new("failing").writable().failing_adds("write error"));
    let manager = with_add_tool(
        vec![failing],
        MemoryAddToolConfig::builder().wait_for_writes(false).build().into(),
    );
    let result = invoke(&find_tool(&manager, "add_memory"), json!({"entries": ["a", "b"]})).await;
    assert_eq!(json_content(&result), json!({"accepted": 2}));
}

// --- initAgent ---------------------------------------------------------------------------------

#[tokio::test]
async fn init_agent_does_not_throw() {
    let manager = MemoryManager::new(manager(vec![store("test")])).unwrap();
    manager.init_agent(&mut local_agent()).await.unwrap();
}

#[tokio::test]
async fn does_not_register_injection_middleware_when_injection_is_disabled() {
    let manager = MemoryManager::new(MemoryManagerConfig {
        injection: Some(false.into()),
        ..manager(vec![store("test")])
    })
    .unwrap();
    let mut agent = local_agent();
    manager.init_agent(&mut agent).await.unwrap();
    assert_eq!(agent.middleware().len::<InvokeModelStage>(), 0);
}

#[tokio::test]
async fn registers_an_invoke_model_stage_input_middleware_when_injection_is_enabled() {
    let manager = MemoryManager::new(MemoryManagerConfig {
        injection: Some(true.into()),
        ..manager(vec![store("test")])
    })
    .unwrap();
    let mut agent = local_agent();
    manager.init_agent(&mut agent).await.unwrap();
    assert_eq!(agent.middleware().len::<InvokeModelStage>(), 1);
}

#[tokio::test]
async fn wires_the_registered_middleware_to_the_memory_provide_pipeline_folds_a_search_hit() {
    let s = searchable("s", &["dark mode preferred"]);
    let model = MockModel::new().with_turn("ok");
    let mut agent = Agent::builder()
        .model(model.clone())
        .printer(false)
        .messages(vec![Message::assistant("prior")])
        .memory_manager(manager(vec![s.clone()]))
        .build()
        .unwrap();
    agent.invoke("what is my plan").await.unwrap();
    let request = &model.requests()[0];
    let contents: Vec<Value> = request
        .messages
        .iter()
        .map(|message| serde_json::to_value(&message.content).unwrap())
        .collect();
    assert_eq!(
        contents,
        [
            json!([{"text": "prior"}]),
            json!([
                {"text": "what is my plan"},
                {"text": "\n\n<memory>\n<entry source=\"s\">dark mode preferred</entry>\n</memory>"}
            ])
        ]
    );
    assert_eq!(
        *s.searches.lock().unwrap(),
        [(
            "what is my plan".to_owned(),
            SearchOptions {
                max_search_results: Some(5)
            }
        )]
    );
    assert_eq!(agent.messages()[1].content.len(), 1);
}

#[tokio::test]
async fn the_middleware_folds_through_the_injection_engine() {
    let s = searchable("s", &["dark mode preferred"]);
    let manager = MemoryManager::new(manager(vec![s])).unwrap();
    let mut agent = local_agent();
    manager.init_agent(&mut agent).await.unwrap();
    let context = model_context(vec![Message::assistant("prior"), Message::user("what is my plan")]);
    let config = manager.injection_config().cloned().unwrap();
    let text = manager.provide_memory_context(&context.messages).await.unwrap();
    assert_eq!(
        text.as_deref(),
        Some("<memory>\n<entry source=\"s\">dark mode preferred</entry>\n</memory>")
    );
    assert!(config.trigger.is_none());
}

// --- injection ---------------------------------------------------------------------------------

fn with_injection(store: Arc<MockStore>, injection: MemoryInjectionConfig) -> MemoryManager {
    MemoryManager::new(MemoryManagerConfig {
        injection: Some(injection.into()),
        ..manager(vec![store])
    })
    .unwrap()
}

#[test]
fn defaults_to_an_empty_config_enabled_when_injection_is_omitted() {
    let manager = MemoryManager::new(manager(vec![store("s")])).unwrap();
    let config = manager.injection_config().unwrap();
    assert!(config.trigger.is_none() && config.max_entries.is_none());
}

#[test]
fn is_false_when_injection_is_explicitly_false() {
    let manager = MemoryManager::new(MemoryManagerConfig {
        injection: Some(false.into()),
        ..manager(vec![store("s")])
    })
    .unwrap();
    assert!(manager.injection_config().is_none());
}

#[test]
fn resolves_to_an_empty_config_when_injection_is_true() {
    let manager = MemoryManager::new(MemoryManagerConfig {
        injection: Some(true.into()),
        ..manager(vec![store("s")])
    })
    .unwrap();
    assert!(manager.injection_config().unwrap().max_entries.is_none());
}

#[test]
fn passes_an_injection_config_object_through_unchanged() {
    let manager = with_injection(
        store("s"),
        MemoryInjectionConfig {
            max_entries: Some(5),
            ..Default::default()
        },
    );
    assert_eq!(manager.injection_config().unwrap().max_entries, Some(5));
}

fn last_query(store: &MockStore) -> Option<(String, Option<usize>)> {
    store
        .searches
        .lock()
        .unwrap()
        .last()
        .map(|(query, options)| (query.clone(), options.max_search_results))
}

#[tokio::test]
async fn uses_the_latest_user_ask_on_a_user_turn_adaptive_default() {
    let s = searchable("s", &["fact"]);
    let manager = with_injection(s.clone(), MemoryInjectionConfig::default());
    manager
        .provide_memory_context(&[Message::assistant("prior step"), Message::user("what is my plan")])
        .await
        .unwrap();
    assert_eq!(last_query(&s), Some(("what is my plan".to_owned(), Some(5))));
}

#[tokio::test]
async fn uses_the_most_recent_assistant_text_on_an_autonomous_tool_result_turn() {
    let s = searchable("s", &["fact"]);
    let manager = with_injection(s.clone(), MemoryInjectionConfig::default());
    manager
        .provide_memory_context(&[
            Message::user("task"),
            Message::assistant("the previous step result"),
            tool_result_message(),
        ])
        .await
        .unwrap();
    assert_eq!(last_query(&s), Some(("the previous step result".to_owned(), Some(5))));
}

#[tokio::test]
async fn honors_a_custom_query() {
    let s = searchable("s", &["fact"]);
    let manager = with_injection(
        s.clone(),
        MemoryInjectionConfig {
            query: Some(MemoryQuery::new(|_| Ok(Some("custom query".into())))),
            ..Default::default()
        },
    );
    manager
        .provide_memory_context(&[Message::assistant("prior"), Message::user("ask")])
        .await
        .unwrap();
    assert_eq!(last_query(&s), Some(("custom query".to_owned(), Some(5))));
}

#[tokio::test]
async fn skips_returns_undefined_when_a_custom_query_returns_undefined() {
    let s = searchable("s", &["fact"]);
    let manager = with_injection(
        s.clone(),
        MemoryInjectionConfig {
            query: Some(MemoryQuery::new(|_| Ok(None))),
            ..Default::default()
        },
    );
    let text = manager
        .provide_memory_context(&[Message::assistant("prior"), Message::user("ask")])
        .await
        .unwrap();
    assert_eq!(text, None);
    assert_eq!(s.search_count(), 0);
}

#[tokio::test]
async fn fails_open_returns_undefined_when_a_custom_query_throws() {
    let s = searchable("s", &["fact"]);
    let manager = with_injection(
        s.clone(),
        MemoryInjectionConfig {
            query: Some(MemoryQuery::new(|_| Err("boom".into()))),
            ..Default::default()
        },
    );
    let text = manager
        .provide_memory_context(&[Message::assistant("prior"), Message::user("ask")])
        .await
        .unwrap();
    assert_eq!(text, None);
    assert_eq!(s.search_count(), 0);
}

#[tokio::test]
async fn skips_when_the_latest_assistant_message_has_no_text_pure_tool_use() {
    let s = searchable("s", &["fact"]);
    let manager = with_injection(s.clone(), MemoryInjectionConfig::default());
    let text = manager
        .provide_memory_context(&[tool_use_message(), tool_result_message()])
        .await
        .unwrap();
    assert_eq!(text, None);
    assert_eq!(s.search_count(), 0);
}

#[tokio::test]
async fn returns_undefined_when_search_yields_no_entries() {
    let s = store("s");
    let manager = with_injection(s.clone(), MemoryInjectionConfig::default());
    let text = manager
        .provide_memory_context(&[Message::assistant("prior"), Message::user("ask")])
        .await
        .unwrap();
    assert_eq!(text, None);
    assert_eq!(s.search_count(), 1);
}

fn joined(separator: &'static str) -> MemoryFormat {
    MemoryFormat::new(move |entries| {
        Ok(entries
            .iter()
            .map(|entry| entry.content.as_str())
            .collect::<Vec<_>>()
            .join(separator))
    })
}

#[tokio::test]
async fn honors_max_entries_and_caps_the_rendered_entries() {
    let s = searchable("s", &["A", "B", "C"]);
    let manager = with_injection(
        s.clone(),
        MemoryInjectionConfig {
            max_entries: Some(2),
            format: Some(joined(",")),
            ..Default::default()
        },
    );
    let text = manager
        .provide_memory_context(&[Message::assistant("prior"), Message::user("ask")])
        .await
        .unwrap();
    assert_eq!(last_query(&s), Some(("ask".to_owned(), Some(2))));
    assert_eq!(text.as_deref(), Some("A,B"));
}

#[tokio::test]
async fn default_renders_a_memory_block_with_per_entry_source_attribution() {
    let manager = with_injection(
        searchable("s", &["dark mode preferred"]),
        MemoryInjectionConfig::default(),
    );
    let text = manager
        .provide_memory_context(&[Message::assistant("prior"), Message::user("ask")])
        .await
        .unwrap();
    assert_eq!(
        text.as_deref(),
        Some("<memory>\n<entry source=\"s\">dark mode preferred</entry>\n</memory>")
    );
}

#[test]
fn omits_the_source_attribute_for_an_entry_with_no_store_name() {
    assert_eq!(
        memory_manager::default_injection_format(&[MemoryEntry::new("no source")]),
        "<memory>\n<entry>no source</entry>\n</memory>"
    );
}

#[test]
fn escapes_xml_in_entry_content_and_source_so_untrusted_text_cannot_break_the_block() {
    assert_eq!(
        memory_manager::default_injection_format(&[entry("a < b & c > d </entry>", "pre\"f")]),
        "<memory>\n<entry source=\"pre&quot;f\">a &lt; b &amp; c &gt; d &lt;/entry&gt;</entry>\n</memory>"
    );
}

#[tokio::test]
async fn honors_a_custom_format() {
    let manager = with_injection(
        searchable("s", &["A"]),
        MemoryInjectionConfig {
            format: Some(MemoryFormat::new(|entries| {
                Ok(format!(
                    "[{}]",
                    entries
                        .iter()
                        .map(|entry| entry.content.as_str())
                        .collect::<Vec<_>>()
                        .join("|")
                ))
            })),
            ..Default::default()
        },
    );
    let text = manager
        .provide_memory_context(&[Message::assistant("prior"), Message::user("ask")])
        .await
        .unwrap();
    assert_eq!(text.as_deref(), Some("[A]"));
}

#[tokio::test]
async fn fails_open_returns_undefined_when_a_custom_format_throws() {
    let s = searchable("s", &["fact"]);
    let manager = with_injection(
        s.clone(),
        MemoryInjectionConfig {
            format: Some(MemoryFormat::new(|_| Err("boom".into()))),
            ..Default::default()
        },
    );
    let text = manager
        .provide_memory_context(&[Message::assistant("prior"), Message::user("ask")])
        .await
        .unwrap();
    assert_eq!(text, None);
    assert_eq!(s.search_count(), 1);
}

// --- AgentConfig integration -------------------------------------------------------------------

#[test]
fn auto_wraps_memory_manager_config_into_memory_manager_instance() {
    let agent = Agent::builder()
        .model(MockModel::new())
        .printer(false)
        .memory_manager(manager(vec![store("test")]))
        .build()
        .unwrap();
    assert!(agent.memory_manager().is_some());
}

#[test]
fn passes_through_memory_manager_instance_unchanged() {
    let instance = MemoryManager::new(manager(vec![store("test")])).unwrap();
    let agent = Agent::builder()
        .model(MockModel::new())
        .printer(false)
        .memory_manager(instance.clone())
        .build()
        .unwrap();
    assert!(agent.memory_manager().unwrap().same_as(&instance));
}

#[test]
fn shares_the_manager_an_arc_holds() {
    let instance = Arc::new(MemoryManager::new(manager(vec![store("test")])).unwrap());
    let agent = Agent::builder()
        .model(MockModel::new())
        .printer(false)
        .memory_manager(instance.clone())
        .build()
        .unwrap();
    assert!(agent.memory_manager().unwrap().same_as(&instance));
}

#[test]
fn sets_memory_manager_to_undefined_when_not_configured() {
    let agent = Agent::builder().model(MockModel::new()).printer(false).build().unwrap();
    assert!(agent.memory_manager().is_none());
}

#[test]
fn an_invalid_memory_manager_config_fails_the_agent_build() {
    let error = Agent::builder()
        .model(MockModel::new())
        .printer(false)
        .memory_manager(MemoryManagerConfig::default())
        .build()
        .unwrap_err();
    assert_eq!(error.to_string(), "MemoryManager: at least one store is required");
}

#[tokio::test]
async fn registers_the_memory_tools_with_the_agent() {
    let mut agent = Agent::builder()
        .model(MockModel::new().with_turn("ok"))
        .printer(false)
        .memory_manager(manager(vec![store("test")]))
        .build()
        .unwrap();
    agent.invoke("hi").await.unwrap();
    assert!(agent.local().tool_registry().get("search_memory").is_some());
}
