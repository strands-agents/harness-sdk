use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::json;
use tokio::sync::Notify;

use super::coordinator::{
    BACKOFF_PROBE_INTERVAL, ExtractionBinding, ExtractionCoordinator, SAVE_FAILURES_BEFORE_BACKOFF,
};
use super::resolve::{DEFAULT_EXTRACTION_TRIGGER_TURNS, resolve_extraction_config};
use super::*;
use crate::agent::{InvocationState, LocalAgent};
use crate::hooks::{AfterInvocationEvent, MessageAddedEvent};
use crate::memory::tests::MockStore;
use crate::memory::{
    AddMessagesContext, MemoryEntry, MemoryManager, MemoryManagerConfig, MemoryStore, SearchOptions, Toggle,
};
use crate::plugins::Plugin;
use crate::testing::MockModel;
use crate::types::{JsonValue, Role, ToolUseBlock};

fn invocation() -> Arc<dyn ExtractionTrigger> {
    Arc::new(InvocationTrigger::new())
}

fn interval(turns: u64) -> Arc<dyn ExtractionTrigger> {
    Arc::new(IntervalTrigger::new(IntervalTriggerOptions { turns }).unwrap())
}

#[derive(Clone, Copy)]
enum Sink {
    Add,
    AddMessages,
    Both,
}

/// A writable store with extraction.
fn extraction_store(name: &str, extraction: Option<ExtractionConfig>, sink: Sink) -> MockStore {
    MockStore {
        writable: true,
        has_add: matches!(sink, Sink::Add | Sink::Both),
        has_add_messages: matches!(sink, Sink::AddMessages | Sink::Both),
        extraction,
        ..MockStore::new(name)
    }
}

fn on(triggers: Vec<Arc<dyn ExtractionTrigger>>) -> Option<ExtractionConfig> {
    Some(ExtractionConfig::default().with_trigger(triggers))
}

fn user(text: &str) -> Message {
    Message::user(text)
}

fn tool_only() -> Message {
    Message::new(Role::Assistant, vec![ToolUseBlock::new("t", "1", json!({})).into()])
}

fn manager_of(stores: Vec<Arc<dyn MemoryStore>>) -> crate::Result<MemoryManager> {
    MemoryManager::new(MemoryManagerConfig {
        stores,
        injection: Some(false.into()),
        ..Default::default()
    })
}

async fn attached(stores: Vec<Arc<dyn MemoryStore>>, agent: &mut LocalAgent) -> MemoryManager {
    let manager = manager_of(stores).unwrap();
    manager.init_agent(agent).await.unwrap();
    manager
}

async fn add_messages(agent: &mut LocalAgent, messages: Vec<Message>) {
    for message in messages {
        let hooks = agent.hooks().clone();
        let mut event = MessageAddedEvent::new(agent, InvocationState::new(), message);
        hooks.invoke(&mut event).await.unwrap();
    }
}

async fn after_invocation(agent: &mut LocalAgent) {
    let hooks = agent.hooks().clone();
    let mut event = AfterInvocationEvent::new(agent, InvocationState::new());
    hooks.invoke(&mut event).await.unwrap();
}

/// Fires the after-invocation hooks, then flushes so the background save has finished.
async fn fire_invocation(agent: &mut LocalAgent, manager: &MemoryManager) {
    after_invocation(agent).await;
    manager.flush().await;
}

fn agent() -> LocalAgent {
    crate::test_support::local_agent()
}

fn texts(messages: &[Message]) -> Vec<String> {
    messages.iter().map(Message::text).collect()
}

fn sequence_numbers(context: &AddMessagesContext) -> Vec<u64> {
    context.sequence_numbers.clone().unwrap_or_default()
}

/// Records each call and returns fixed entries.
#[derive(Default)]
struct RecordingExtractor {
    entries: Vec<ExtractionResult>,
    calls: Mutex<Vec<(Vec<Message>, ExtractorContext)>>,
}

impl RecordingExtractor {
    fn returning(entries: &[ExtractionResult]) -> Arc<Self> {
        Arc::new(Self {
            entries: entries.to_vec(),
            calls: Mutex::default(),
        })
    }

    fn call_count(&self) -> usize {
        self.calls.lock().unwrap().len()
    }
}

#[async_trait]
impl Extractor for RecordingExtractor {
    async fn extract(&self, messages: &[Message], context: ExtractorContext) -> crate::Result<Vec<ExtractionResult>> {
        self.calls.lock().unwrap().push((messages.to_vec(), context));
        Ok(self.entries.clone())
    }
}

fn with_extractor(
    triggers: Vec<Arc<dyn ExtractionTrigger>>,
    extractor: Arc<dyn Extractor>,
) -> Option<ExtractionConfig> {
    Some(
        ExtractionConfig::default()
            .with_trigger(triggers)
            .with_extractor(extractor),
    )
}

fn binding(store: &Arc<MockStore>) -> ExtractionBinding {
    ExtractionBinding {
        store: store.clone(),
        config: resolve_extraction_config(store.extraction.clone(), store.as_ref()).unwrap(),
    }
}

fn coordinator(stores: &[&Arc<MockStore>]) -> ExtractionCoordinator {
    ExtractionCoordinator::new(
        stores.iter().map(|store| binding(store)).collect(),
        Arc::new(MockModel::new()),
        Arc::new(crate::telemetry::Tracer::default()),
    )
}

fn failing_store(name: &str) -> Arc<MockStore> {
    let store = extraction_store(name, on(vec![invocation()]), Sink::AddMessages);
    *store.add_messages_error.lock().unwrap() = Some("backend down".into());
    Arc::new(store)
}

// --- constructor validation --------------------------------------------------------------------

#[test]
fn throws_when_an_extraction_store_is_not_writable() {
    let store = MockStore {
        extraction: on(vec![invocation()]),
        ..MockStore::new("s")
    };
    let error = manager_of(vec![Arc::new(store)]).unwrap_err();
    assert!(error.to_string().contains("not writable"));
}

#[test]
fn throws_when_an_extraction_config_has_no_triggers() {
    let store = extraction_store("s", on(vec![]), Sink::Both);
    let error = manager_of(vec![Arc::new(store)]).unwrap_err();
    assert!(error.to_string().contains("no triggers"));
}

#[test]
fn allows_a_store_writable_only_via_add_messages() {
    let store = extraction_store("s", on(vec![invocation()]), Sink::AddMessages);
    assert!(manager_of(vec![Arc::new(store)]).is_ok());
}

#[test]
fn throws_when_a_writable_store_has_neither_add_nor_add_messages() {
    let store = MockStore {
        writable: true,
        ..MockStore::new("s")
    };
    let error = manager_of(vec![Arc::new(store)]).unwrap_err();
    assert!(error.to_string().contains("no add or addMessages"));
}

#[test]
fn rejects_add_tool_config_targeting_an_add_messages_only_store() {
    let store = extraction_store("s", on(vec![invocation()]), Sink::AddMessages);
    let error = MemoryManager::new(MemoryManagerConfig {
        stores: vec![Arc::new(store)],
        add_tool_config: Some(true.into()),
        ..Default::default()
    })
    .unwrap_err();
    assert!(error.to_string().contains("no writable stores implement add"));
}

#[test]
fn throws_when_extraction_has_an_extractor_but_the_store_has_no_add() {
    let extractor = RecordingExtractor::returning(&[]);
    let store = extraction_store("s", with_extractor(vec![invocation()], extractor), Sink::AddMessages);
    let error = manager_of(vec![Arc::new(store)]).unwrap_err();
    assert!(error.to_string().contains("has an extractor but no add method"));
}

// --- config resolution -------------------------------------------------------------------------

#[tokio::test]
async fn enables_extraction_with_defaults_via_the_boolean_shorthand() {
    let store = Arc::new(extraction_store(
        "s",
        Some(ExtractionConfig::default()),
        Sink::AddMessages,
    ));
    let mut agent = agent();
    let manager = attached(vec![store.clone()], &mut agent).await;
    add_messages(&mut agent, vec![user("remember this")]).await;
    manager.flush().await;
    assert_eq!(store.batches().len(), 1);
}

#[tokio::test]
async fn treats_extraction_false_as_disabled_no_hooks_no_writes() {
    let store = Arc::new(extraction_store("s", None, Sink::AddMessages));
    let mut agent = agent();
    let manager = attached(vec![store.clone()], &mut agent).await;
    add_messages(&mut agent, vec![user("ignored")]).await;
    manager.flush().await;
    assert!(store.batches().is_empty());
    assert_eq!(agent.hooks().len(), 0);
}

#[tokio::test]
async fn defaults_an_add_only_store_to_a_model_extractor_extractor_route() {
    let store = Arc::new(extraction_store("s", on(vec![invocation()]), Sink::Add));
    let model = MockModel::new().with_turn(r#"[{"content":"a durable fact"}]"#);
    let mut agent = LocalAgent::new("agent-1", Arc::new(model));
    let manager = attached(vec![store.clone()], &mut agent).await;
    add_messages(&mut agent, vec![user("I like dark mode")]).await;
    fire_invocation(&mut agent, &manager).await;
    assert_eq!(store.add_calls(), [("a durable fact".to_owned(), None)]);
}

#[tokio::test]
async fn defaults_a_both_sinks_store_to_the_passthrough_no_implicit_model_call() {
    let store = Arc::new(extraction_store("s", on(vec![invocation()]), Sink::Both));
    let mut agent = agent();
    let manager = attached(vec![store.clone()], &mut agent).await;
    add_messages(&mut agent, vec![user("hi")]).await;
    fire_invocation(&mut agent, &manager).await;
    assert_eq!(store.batches().len(), 1);
    assert!(store.add_calls().is_empty());
}

// --- no-extractor passthrough ------------------------------------------------------------------

#[tokio::test]
async fn hands_the_raw_message_data_batch_to_add_messages_roles_preserved() {
    let store = Arc::new(extraction_store("s", on(vec![invocation()]), Sink::AddMessages));
    let mut agent = agent();
    let manager = attached(vec![store.clone()], &mut agent).await;
    add_messages(
        &mut agent,
        vec![user("I prefer dark mode"), Message::assistant("Noted")],
    )
    .await;
    fire_invocation(&mut agent, &manager).await;
    let batches = store.batches();
    assert_eq!(batches.len(), 1);
    let roles: Vec<Role> = batches[0].0.iter().map(|message| message.role).collect();
    assert_eq!(roles, [Role::User, Role::Assistant]);
}

// --- addMessages context -----------------------------------------------------------------------

#[tokio::test]
async fn passes_sequence_numbers_index_aligned_with_the_filtered_batch() {
    let store = Arc::new(extraction_store("s", on(vec![invocation()]), Sink::AddMessages));
    let mut agent = agent();
    let manager = attached(vec![store.clone()], &mut agent).await;
    add_messages(&mut agent, vec![user("first"), user("second")]).await;
    fire_invocation(&mut agent, &manager).await;
    let (batch, context) = store.batches().remove(0);
    assert_eq!(context, AddMessagesContext::default().with_sequence_numbers(vec![0, 1]));
    assert_eq!(sequence_numbers(&context).len(), batch.len());
}

#[tokio::test]
async fn keeps_a_message_seq_when_a_message_before_it_is_filtered_to_empty_gap() {
    let store = Arc::new(extraction_store("s", on(vec![invocation()]), Sink::AddMessages));
    let mut agent = agent();
    let manager = attached(vec![store.clone()], &mut agent).await;
    add_messages(&mut agent, vec![user("a"), tool_only(), user("b")]).await;
    fire_invocation(&mut agent, &manager).await;
    let (batch, context) = store.batches().remove(0);
    assert_eq!(batch.len(), 2);
    assert_eq!(sequence_numbers(&context), [0, 2]);
}

#[tokio::test]
async fn re_fires_the_same_seqs_for_a_multi_message_batch_whose_save_failed_stable_across_retries() {
    let store = Arc::new(extraction_store("s", on(vec![invocation()]), Sink::AddMessages));
    store
        .add_messages_script
        .lock()
        .unwrap()
        .push_back(Some("backend down".into()));
    let mut agent = agent();
    let manager = attached(vec![store.clone()], &mut agent).await;
    add_messages(&mut agent, vec![user("first"), user("second")]).await;
    fire_invocation(&mut agent, &manager).await;
    fire_invocation(&mut agent, &manager).await;
    let batches = store.batches();
    assert_eq!(batches.len(), 2);
    assert_eq!(sequence_numbers(&batches[0].1), [0, 1]);
    assert_eq!(batches[1].1, batches[0].1);
}

#[tokio::test]
async fn anchors_the_seq_to_the_message_not_the_batch_position() {
    let store = Arc::new(extraction_store("s", on(vec![invocation()]), Sink::AddMessages));
    let mut agent = agent();
    let manager = attached(vec![store.clone()], &mut agent).await;
    add_messages(&mut agent, vec![user("turn one")]).await;
    fire_invocation(&mut agent, &manager).await;
    store
        .add_messages_script
        .lock()
        .unwrap()
        .push_back(Some("backend down".into()));
    add_messages(&mut agent, vec![user("turn two")]).await;
    fire_invocation(&mut agent, &manager).await;
    fire_invocation(&mut agent, &manager).await;
    let batches = store.batches();
    assert_eq!(batches.len(), 3);
    assert_eq!(sequence_numbers(&batches[2].1), [1]);
}

#[tokio::test]
async fn gives_each_store_index_aligned_seqs_from_the_shared_buffer() {
    let a = Arc::new(extraction_store("a", on(vec![invocation()]), Sink::AddMessages));
    let b = Arc::new(extraction_store("b", on(vec![invocation()]), Sink::AddMessages));
    let mut agent = agent();
    let manager = attached(vec![a.clone(), b.clone()], &mut agent).await;
    add_messages(&mut agent, vec![user("first"), user("second")]).await;
    fire_invocation(&mut agent, &manager).await;
    assert_eq!(sequence_numbers(&a.batches()[0].1), [0, 1]);
    assert_eq!(sequence_numbers(&b.batches()[0].1), [0, 1]);
}

#[tokio::test]
async fn does_not_pass_sequence_numbers_on_the_extractor_route() {
    let extractor = RecordingExtractor::returning(&[ExtractionResult::new("fact")]);
    let store = Arc::new(extraction_store(
        "s",
        with_extractor(vec![invocation()], extractor.clone()),
        Sink::Both,
    ));
    let mut agent = agent();
    let manager = attached(vec![store.clone()], &mut agent).await;
    add_messages(&mut agent, vec![user("something happened")]).await;
    fire_invocation(&mut agent, &manager).await;
    assert!(store.batches().is_empty());
    assert_eq!(extractor.call_count(), 1);
    assert!(extractor.calls.lock().unwrap()[0].1.default_model.is_some());
}

// --- extractor route ---------------------------------------------------------------------------

#[tokio::test]
async fn calls_the_extractor_and_writes_each_entry_via_add() {
    let metadata = json!({"k": "v"}).as_object().cloned().unwrap();
    let extractor = RecordingExtractor::returning(&[
        ExtractionResult::new("fact one"),
        ExtractionResult::new("fact two").with_metadata(metadata.clone()),
    ]);
    let store = Arc::new(extraction_store(
        "s",
        with_extractor(vec![invocation()], extractor.clone()),
        Sink::Both,
    ));
    let mut agent = agent();
    let manager = attached(vec![store.clone()], &mut agent).await;
    add_messages(&mut agent, vec![user("something happened")]).await;
    fire_invocation(&mut agent, &manager).await;
    assert_eq!(extractor.call_count(), 1);
    assert_eq!(
        store.add_calls(),
        [("fact one".to_owned(), None), ("fact two".to_owned(), Some(metadata))]
    );
    assert!(store.batches().is_empty());
}

#[tokio::test]
async fn passes_the_agent_aux_model_as_default_model_to_the_extractor() {
    let extractor = RecordingExtractor::returning(&[]);
    let store = Arc::new(extraction_store(
        "s",
        with_extractor(vec![invocation()], extractor.clone()),
        Sink::Both,
    ));
    let mut agent = agent();
    let aux: Arc<dyn crate::models::Model> = Arc::new(MockModel::new());
    agent.set_aux_model(Some(aux.clone()));
    let manager = attached(vec![store], &mut agent).await;
    add_messages(&mut agent, vec![user("hi")]).await;
    fire_invocation(&mut agent, &manager).await;
    let calls = extractor.calls.lock().unwrap();
    assert!(Arc::ptr_eq(calls[0].1.default_model.as_ref().unwrap(), &aux));
}

/// A store whose first `add` waits until the second starts.
#[derive(Default)]
struct ConcurrentStore {
    started: Notify,
    calls: Mutex<usize>,
    first_saw_second: Mutex<bool>,
}

#[async_trait]
impl MemoryStore for ConcurrentStore {
    fn name(&self) -> &str {
        "s"
    }

    fn writable(&self) -> bool {
        true
    }

    fn extraction(&self) -> Option<ExtractionConfig> {
        with_extractor(
            vec![invocation()],
            RecordingExtractor::returning(&[ExtractionResult::new("a"), ExtractionResult::new("b")]),
        )
    }

    async fn search(&self, _query: &str, _options: SearchOptions) -> crate::Result<Vec<MemoryEntry>> {
        Ok(Vec::new())
    }

    fn implements_add(&self) -> bool {
        true
    }

    async fn add(&self, _content: &str, _metadata: Option<crate::types::JsonObject>) -> crate::Result<JsonValue> {
        let call = {
            let mut calls = self.calls.lock().unwrap();
            *calls += 1;
            *calls
        };
        if call == 1 {
            self.started.notified().await;
            *self.first_saw_second.lock().unwrap() = true;
        } else {
            self.started.notify_one();
        }
        Ok(JsonValue::Null)
    }
}

#[tokio::test]
async fn writes_entries_concurrently_rather_than_serially() {
    let store = Arc::new(ConcurrentStore::default());
    let mut agent = agent();
    let manager = attached(vec![store.clone()], &mut agent).await;
    add_messages(&mut agent, vec![user("x")]).await;
    fire_invocation(&mut agent, &manager).await;
    assert_eq!(*store.calls.lock().unwrap(), 2);
    assert!(*store.first_saw_second.lock().unwrap());
}

#[tokio::test]
async fn rolls_back_and_retries_the_whole_batch_if_any_entry_write_fails() {
    let extractor = RecordingExtractor::returning(&[ExtractionResult::new("a"), ExtractionResult::new("b")]);
    let store = Arc::new(extraction_store(
        "s",
        with_extractor(vec![invocation()], extractor.clone()),
        Sink::Add,
    ));
    store
        .add_script
        .lock()
        .unwrap()
        .extend([None, Some("write failed".to_owned())]);
    let mut agent = agent();
    let manager = attached(vec![store.clone()], &mut agent).await;
    add_messages(&mut agent, vec![user("x")]).await;
    fire_invocation(&mut agent, &manager).await;
    fire_invocation(&mut agent, &manager).await;
    assert_eq!(store.add_calls().len(), 4);
    assert_eq!(extractor.call_count(), 2);
}

// --- message filter ----------------------------------------------------------------------------

#[tokio::test]
async fn drops_tool_use_tool_result_blocks_by_default_and_empties() {
    let store = Arc::new(extraction_store("s", on(vec![invocation()]), Sink::AddMessages));
    let mut agent = agent();
    let manager = attached(vec![store.clone()], &mut agent).await;
    add_messages(&mut agent, vec![user("keep me"), tool_only()]).await;
    fire_invocation(&mut agent, &manager).await;
    let batch = &store.batches()[0].0;
    assert_eq!(batch.len(), 1);
    assert_eq!(batch[0].role, Role::User);
}

#[tokio::test]
async fn honors_a_custom_filter() {
    let config = ExtractionConfig::default()
        .with_trigger([invocation()])
        .with_filter(MemoryMessageFilter {
            exclude: vec![MemoryContentBlockType::Text],
        });
    let store = Arc::new(extraction_store("s", Some(config), Sink::AddMessages));
    let mut agent = agent();
    let manager = attached(vec![store.clone()], &mut agent).await;
    add_messages(&mut agent, vec![user("this is text and should be excluded")]).await;
    fire_invocation(&mut agent, &manager).await;
    assert!(store.batches().is_empty());
}

// --- high-water-mark dedup ---------------------------------------------------------------------

#[tokio::test]
async fn processes_only_messages_added_since_the_last_fire() {
    let store = Arc::new(extraction_store("s", on(vec![invocation()]), Sink::AddMessages));
    let mut agent = agent();
    let manager = attached(vec![store.clone()], &mut agent).await;
    add_messages(&mut agent, vec![user("turn one")]).await;
    fire_invocation(&mut agent, &manager).await;
    add_messages(&mut agent, vec![user("turn two")]).await;
    fire_invocation(&mut agent, &manager).await;
    let batches = store.batches();
    assert_eq!(batches.len(), 2);
    assert_eq!(texts(&batches[0].0), ["turn one"]);
    assert_eq!(texts(&batches[1].0), ["turn two"]);
}

#[tokio::test]
async fn does_nothing_when_no_new_messages_since_the_mark() {
    let store = Arc::new(extraction_store("s", on(vec![invocation()]), Sink::AddMessages));
    let mut agent = agent();
    let manager = attached(vec![store.clone()], &mut agent).await;
    add_messages(&mut agent, vec![user("only turn")]).await;
    fire_invocation(&mut agent, &manager).await;
    fire_invocation(&mut agent, &manager).await;
    assert_eq!(store.batches().len(), 1);
}

#[tokio::test]
async fn retries_the_same_messages_on_the_next_fire_if_a_write_fails() {
    let store = Arc::new(extraction_store("s", on(vec![invocation()]), Sink::AddMessages));
    store
        .add_messages_script
        .lock()
        .unwrap()
        .push_back(Some("backend down".into()));
    let mut agent = agent();
    let manager = attached(vec![store.clone()], &mut agent).await;
    add_messages(&mut agent, vec![user("important")]).await;
    fire_invocation(&mut agent, &manager).await;
    fire_invocation(&mut agent, &manager).await;
    let batches = store.batches();
    assert_eq!(batches.len(), 2);
    assert_eq!(batches[1].0.len(), 1);
}

// --- backing off and recovering ----------------------------------------------------------------

const PROBES: u32 = 2;

#[tokio::test]
async fn backs_off_to_periodic_probes_after_save_failures_before_backoff_failures_in_a_row() {
    let store = failing_store("s");
    let coordinator = coordinator(&[&store]);
    for index in 0..SAVE_FAILURES_BEFORE_BACKOFF + BACKOFF_PROBE_INTERVAL * PROBES {
        coordinator.record(user(&format!("m{index}")));
        coordinator.process(0, None).await;
    }
    assert_eq!(store.batches().len(), (SAVE_FAILURES_BEFORE_BACKOFF + PROBES) as usize);
}

#[tokio::test]
async fn recovers_and_saves_the_buffered_backlog_when_the_store_comes_back() {
    let store = failing_store("s");
    let mut agent = agent();
    let manager = attached(vec![store.clone()], &mut agent).await;
    for index in 0..SAVE_FAILURES_BEFORE_BACKOFF {
        add_messages(&mut agent, vec![user(&format!("down{index}"))]).await;
        fire_invocation(&mut agent, &manager).await;
    }
    *store.add_messages_error.lock().unwrap() = None;
    store.batches.lock().unwrap().clear();
    for index in 0..BACKOFF_PROBE_INTERVAL {
        add_messages(&mut agent, vec![user(&format!("up{index}"))]).await;
        fire_invocation(&mut agent, &manager).await;
    }
    let saved: Vec<String> = store.batches().iter().flat_map(|(batch, _)| texts(batch)).collect();
    assert!(saved.contains(&"down0".to_owned()));
    assert!(saved.contains(&"up0".to_owned()));
}

#[tokio::test]
async fn a_healthy_store_keeps_saving_every_request_while_a_sibling_is_backed_off() {
    let bad = failing_store("bad");
    let good = Arc::new(extraction_store("good", on(vec![invocation()]), Sink::AddMessages));
    let coordinator = coordinator(&[&bad, &good]);
    let requests = SAVE_FAILURES_BEFORE_BACKOFF + BACKOFF_PROBE_INTERVAL * PROBES;
    for index in 0..requests {
        coordinator.record(user(&format!("m{index}")));
        coordinator.process(0, None).await;
        coordinator.process(1, None).await;
    }
    assert_eq!(good.batches().len(), requests as usize);
    assert_eq!(bad.batches().len(), (SAVE_FAILURES_BEFORE_BACKOFF + PROBES) as usize);
}

#[tokio::test]
async fn flush_resolves_even_when_a_store_is_failing() {
    let store = failing_store("s");
    let mut agent = agent();
    let manager = attached(vec![store], &mut agent).await;
    add_messages(&mut agent, vec![user("x")]).await;
    fire_invocation(&mut agent, &manager).await;
    manager.flush().await;
}

#[tokio::test]
async fn flush_bypasses_backoff_and_writes_the_backlog_of_a_recovered_store() {
    let store = failing_store("s");
    let coordinator = coordinator(&[&store]);
    for index in 0..SAVE_FAILURES_BEFORE_BACKOFF {
        coordinator.record(user(&format!("down{index}")));
        coordinator.process(0, None).await;
    }
    *store.add_messages_error.lock().unwrap() = None;
    store.batches.lock().unwrap().clear();
    coordinator.record(user("final"));
    coordinator.flush().await;
    let batches = store.batches();
    assert_eq!(batches.len(), 1);
    let saved = texts(&batches[0].0);
    assert!(saved.contains(&"final".to_owned()));
    assert!(saved.contains(&"down0".to_owned()));
}

#[tokio::test]
async fn a_fully_filtered_empty_turn_does_not_reset_the_failure_streak() {
    let store = failing_store("s");
    let coordinator = coordinator(&[&store]);
    for index in 0..SAVE_FAILURES_BEFORE_BACKOFF - 1 {
        coordinator.record(user(&format!("m{index}")));
        coordinator.process(0, None).await;
    }
    coordinator.record(tool_only());
    coordinator.process(0, None).await;
    coordinator.record(user("nth"));
    coordinator.process(0, None).await;
    store.batches.lock().unwrap().clear();
    coordinator.record(user("after"));
    coordinator.process(0, None).await;
    assert!(store.batches().is_empty());
}

// --- triggers ----------------------------------------------------------------------------------

#[tokio::test]
async fn interval_trigger_fires_every_n_invocations() {
    let store = Arc::new(extraction_store("s", on(vec![interval(2)]), Sink::AddMessages));
    let mut agent = agent();
    let manager = attached(vec![store.clone()], &mut agent).await;
    add_messages(&mut agent, vec![user("a")]).await;
    after_invocation(&mut agent).await;
    tokio::task::yield_now().await;
    assert!(store.batches().is_empty());
    add_messages(&mut agent, vec![user("b")]).await;
    fire_invocation(&mut agent, &manager).await;
    let batches = store.batches();
    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0].0.len(), 2);
}

#[test]
fn interval_trigger_rejects_non_positive_turns() {
    let error = IntervalTrigger::new(IntervalTriggerOptions { turns: 0 }).unwrap_err();
    assert_eq!(
        error.to_string(),
        "IntervalTrigger: turns must be a positive integer, got 0"
    );
}

#[tokio::test]
async fn accepts_a_single_trigger_not_wrapped_in_an_array() {
    let store = Arc::new(extraction_store("s", on(vec![invocation()]), Sink::AddMessages));
    let mut agent = agent();
    let manager = attached(vec![store.clone()], &mut agent).await;
    add_messages(&mut agent, vec![user("hi")]).await;
    fire_invocation(&mut agent, &manager).await;
    assert_eq!(store.batches().len(), 1);
}

#[tokio::test]
async fn composes_multiple_triggers_extraction_fires_on_any() {
    let store = Arc::new(extraction_store(
        "s",
        on(vec![interval(2), invocation()]),
        Sink::AddMessages,
    ));
    let mut agent = agent();
    let manager = attached(vec![store.clone()], &mut agent).await;
    add_messages(&mut agent, vec![user("a")]).await;
    fire_invocation(&mut agent, &manager).await;
    assert_eq!(store.batches().len(), 1);
}

#[tokio::test]
async fn does_not_register_hooks_when_no_store_has_extraction() {
    let store = Arc::new(MockStore::new("s").writable());
    let mut agent = agent();
    attached(vec![store], &mut agent).await;
    assert_eq!(agent.hooks().len(), 0);
}

// --- background execution ----------------------------------------------------------------------

#[tokio::test]
async fn does_not_block_the_after_invocation_event_hook_on_the_store_write() {
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let store = Arc::new(MockStore {
        add_messages_gate: Some(gate.clone()),
        ..extraction_store("s", on(vec![invocation()]), Sink::AddMessages)
    });
    let mut agent = agent();
    let manager = attached(vec![store.clone()], &mut agent).await;
    add_messages(&mut agent, vec![user("hello")]).await;
    after_invocation(&mut agent).await;
    while store.batches().is_empty() {
        tokio::task::yield_now().await;
    }
    assert_eq!(store.batches().len(), 1);
    gate.add_permits(1);
    manager.flush().await;
}

#[tokio::test]
async fn flush_awaits_the_in_flight_extraction_write() {
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let store = Arc::new(MockStore {
        add_messages_gate: Some(gate.clone()),
        ..extraction_store("s", on(vec![invocation()]), Sink::AddMessages)
    });
    let mut agent = agent();
    let manager = attached(vec![store.clone()], &mut agent).await;
    add_messages(&mut agent, vec![user("hello")]).await;
    after_invocation(&mut agent).await;
    let flush = manager.flush();
    gate.add_permits(1);
    flush.await;
    assert_eq!(manager.coordinator().unwrap().pending_len(), 0);
}

#[tokio::test]
async fn flush_is_a_no_op_when_extraction_is_not_configured() {
    let store = Arc::new(MockStore::new("s").writable());
    let mut agent = agent();
    let manager = attached(vec![store], &mut agent).await;
    manager.flush().await;
    assert!(manager.coordinator().is_none());
}

#[tokio::test]
async fn flush_force_extracts_a_buffered_tail_whose_trigger_never_fired() {
    let store = Arc::new(extraction_store("s", on(vec![interval(5)]), Sink::AddMessages));
    let mut agent = agent();
    let manager = attached(vec![store.clone()], &mut agent).await;
    add_messages(&mut agent, vec![user("a")]).await;
    after_invocation(&mut agent).await;
    add_messages(&mut agent, vec![user("b")]).await;
    after_invocation(&mut agent).await;
    assert!(store.batches().is_empty());
    manager.flush().await;
    let batches = store.batches();
    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0].0.len(), 2);
}

#[tokio::test]
async fn flush_does_not_re_extract_messages_already_processed_by_a_fired_trigger() {
    let store = Arc::new(extraction_store("s", on(vec![invocation()]), Sink::AddMessages));
    let mut agent = agent();
    let manager = attached(vec![store.clone()], &mut agent).await;
    add_messages(&mut agent, vec![user("a")]).await;
    fire_invocation(&mut agent, &manager).await;
    assert_eq!(store.batches().len(), 1);
    manager.flush().await;
    assert_eq!(store.batches().len(), 1);
}

#[tokio::test]
async fn agent_shutdown_flushes_the_memory_manager() {
    let store = Arc::new(extraction_store("s", on(vec![interval(5)]), Sink::AddMessages));
    let mut agent = crate::Agent::builder()
        .model(MockModel::new().with_turn("ok"))
        .printer(false)
        .memory_manager(MemoryManagerConfig {
            stores: vec![store.clone()],
            injection: Some(Toggle::Off),
            ..Default::default()
        })
        .build()
        .unwrap();
    agent.invoke("remember this").await.unwrap();
    assert!(store.batches().is_empty());
    agent.shutdown().await.unwrap();
    assert_eq!(texts(&store.batches()[0].0), ["remember this", "ok"]);
}

// --- resolveExtractionConfig -------------------------------------------------------------------

fn sinks(sink: Sink) -> MockStore {
    extraction_store("s", None, sink)
}

#[test]
fn returns_undefined_when_extraction_is_false() {
    assert!(resolve_extraction_config(Toggle::Off.into_option(), &sinks(Sink::Add)).is_none());
}

#[test]
fn returns_undefined_when_extraction_is_undefined() {
    assert!(resolve_extraction_config(None, &sinks(Sink::Add)).is_none());
}

#[test]
fn resolves_true_to_a_fully_defaulted_config() {
    let resolved = resolve_extraction_config(Some(ExtractionConfig::default()), &sinks(Sink::Add)).unwrap();
    assert_eq!(resolved.triggers.len(), 1);
    assert_eq!(resolved.triggers[0].name(), "interval");
    assert_eq!(resolved.filter, MemoryMessageFilter::default());
}

#[test]
fn defaults_an_omitted_trigger_to_an_interval_trigger_of_default_extraction_trigger_turns() {
    let resolved = resolve_extraction_config(Some(ExtractionConfig::default()), &sinks(Sink::AddMessages)).unwrap();
    assert_eq!(resolved.triggers.len(), 1);
    assert_eq!(resolved.triggers[0].name(), "interval");
    assert_eq!(DEFAULT_EXTRACTION_TRIGGER_TURNS, 5);
}

#[test]
fn wraps_a_single_trigger_into_an_array() {
    let trigger = invocation();
    let resolved = resolve_extraction_config(
        Some(ExtractionConfig::default().with_trigger([trigger.clone()])),
        &sinks(Sink::AddMessages),
    )
    .unwrap();
    assert_eq!(resolved.triggers.len(), 1);
    assert!(Arc::ptr_eq(&resolved.triggers[0], &trigger));
}

#[test]
fn passes_an_explicit_trigger_array_through_unchanged() {
    let triggers = vec![invocation(), interval(2)];
    let resolved = resolve_extraction_config(
        Some(ExtractionConfig::default().with_trigger(triggers.clone())),
        &sinks(Sink::AddMessages),
    )
    .unwrap();
    assert!(
        resolved
            .triggers
            .iter()
            .zip(&triggers)
            .all(|(left, right)| Arc::ptr_eq(left, right))
    );
}

#[test]
fn leaves_an_explicit_empty_trigger_array_empty_so_the_manager_can_reject_it() {
    let resolved = resolve_extraction_config(on(vec![]), &sinks(Sink::AddMessages)).unwrap();
    assert!(resolved.triggers.is_empty());
}

#[test]
fn defaults_an_add_only_store_to_a_model_extractor() {
    let resolved = resolve_extraction_config(Some(ExtractionConfig::default()), &sinks(Sink::Add)).unwrap();
    assert!(resolved.extractor.is_some());
}

#[test]
fn defaults_an_add_messages_only_store_to_the_passthrough_no_extractor() {
    let resolved = resolve_extraction_config(Some(ExtractionConfig::default()), &sinks(Sink::AddMessages)).unwrap();
    assert!(resolved.extractor.is_none());
}

#[test]
fn defaults_a_both_sinks_store_to_the_passthrough_no_extractor() {
    let resolved = resolve_extraction_config(Some(ExtractionConfig::default()), &sinks(Sink::Both)).unwrap();
    assert!(resolved.extractor.is_none());
}

#[test]
fn keeps_an_explicit_extractor_even_on_an_add_messages_store() {
    let extractor: Arc<dyn Extractor> = RecordingExtractor::returning(&[]);
    let resolved = resolve_extraction_config(
        Some(ExtractionConfig::default().with_extractor(extractor.clone())),
        &sinks(Sink::Both),
    )
    .unwrap();
    assert!(Arc::ptr_eq(resolved.extractor.as_ref().unwrap(), &extractor));
}

#[test]
fn defaults_to_default_memory_message_filter() {
    let resolved = resolve_extraction_config(Some(ExtractionConfig::default()), &sinks(Sink::Add)).unwrap();
    assert_eq!(
        resolved.filter.exclude,
        [MemoryContentBlockType::ToolUse, MemoryContentBlockType::ToolResult]
    );
}

#[test]
fn passes_an_explicit_filter_through() {
    let filter = MemoryMessageFilter { exclude: vec![] };
    let resolved = resolve_extraction_config(
        Some(ExtractionConfig::default().with_filter(filter.clone())),
        &sinks(Sink::Add),
    )
    .unwrap();
    assert_eq!(resolved.filter, filter);
}

#[test]
fn the_filter_serializes_its_block_kinds_as_wire_keys() {
    assert_eq!(
        serde_json::to_value(MemoryMessageFilter::default()).unwrap(),
        json!({"exclude": ["toolUse", "toolResult"]})
    );
}

/// Fails its first call by panicking, then extracts one entry per call.
#[derive(Default)]
struct PanicsOnce {
    calls: Mutex<Vec<Vec<String>>>,
}

#[async_trait]
impl Extractor for PanicsOnce {
    #[allow(clippy::panic, reason = "the panic is the behaviour under test")]
    async fn extract(&self, messages: &[Message], _context: ExtractorContext) -> crate::Result<Vec<ExtractionResult>> {
        let call = {
            let mut calls = self.calls.lock().unwrap();
            calls.push(texts(messages));
            calls.len()
        };
        if call == 1 {
            panic!("extractor bug");
        }
        Ok(vec![ExtractionResult::new(texts(messages).join(","))])
    }
}

/// A panic in an extractor is a failed save: the messages retry with the next save, and later
/// saves and `flush` still run (a panic would otherwise poison the store's shared save chain).
#[tokio::test]
async fn treats_a_panicking_extractor_as_a_failed_save() {
    let extractor = Arc::new(PanicsOnce::default());
    let store = Arc::new(extraction_store(
        "s",
        with_extractor(vec![invocation()], extractor.clone()),
        Sink::Add,
    ));
    let mut agent = agent();
    let manager = attached(vec![store.clone()], &mut agent).await;
    add_messages(&mut agent, vec![user("first")]).await;
    after_invocation(&mut agent).await;
    add_messages(&mut agent, vec![user("second")]).await;
    fire_invocation(&mut agent, &manager).await;
    assert_eq!(
        *extractor.calls.lock().unwrap(),
        [["first", "second"], ["first", "second"]]
    );
    assert_eq!(store.add_calls(), [("first,second".to_owned(), None)]);
}
