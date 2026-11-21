//! Memory manager tracing, checked on the exported spans.

use std::sync::Arc;

use async_trait::async_trait;
use opentelemetry::Value;
use opentelemetry::trace::SpanId;
use opentelemetry_sdk::trace::SpanData;
use serde_json::json;
use tracing::Instrument;

use super::*;
use crate::memory::extraction::coordinator::{ExtractionBinding, ExtractionCoordinator};
use crate::memory::extraction::resolve::resolve_extraction_config;
use crate::memory::tests::MockStore;
use crate::memory::{
    ExtractionConfig, ExtractionResult, Extractor, ExtractorContext, InvocationTrigger, MemoryFormat, MemoryQuery,
};
use crate::telemetry::test_support::{attr, attr_i64, capture_spans, event_attr, events, is_error};
use crate::testing::MockModel;
use crate::types::{ToolResultBlock, ToolResultStatus};

fn manager_of(stores: Vec<Arc<MockStore>>, injection: bool) -> MemoryManager {
    MemoryManager::new(MemoryManagerConfig {
        stores: stores.into_iter().map(|store| store as Arc<dyn MemoryStore>).collect(),
        injection: Some(injection.into()),
        ..Default::default()
    })
    .unwrap()
}

fn with_format(store: Arc<MockStore>, format: MemoryFormat) -> MemoryManager {
    MemoryManager::new(MemoryManagerConfig {
        stores: vec![store],
        injection: Some(
            MemoryInjectionConfig {
                format: Some(format),
                ..Default::default()
            }
            .into(),
        ),
        ..Default::default()
    })
    .unwrap()
}

fn with_query(store: Arc<MockStore>, query: MemoryQuery) -> MemoryManager {
    MemoryManager::new(MemoryManagerConfig {
        stores: vec![store],
        injection: Some(
            MemoryInjectionConfig {
                query: Some(query),
                ..Default::default()
            }
            .into(),
        ),
        ..Default::default()
    })
    .unwrap()
}

fn store_with(name: &str, entries: &[&str]) -> Arc<MockStore> {
    Arc::new(MockStore::new(name).with_entries(entries))
}

fn results(span: &SpanData) -> serde_json::Value {
    serde_json::from_str(&event_attr(&events(span, "memory.results")[0], "content")).unwrap()
}

fn injected(span: &SpanData) -> Option<Value> {
    attr(span, "memory.injected")
}

/// A writable store that saves raw messages, extracting on every invocation.
fn extraction_store(add_messages: bool) -> Arc<MockStore> {
    Arc::new(MockStore {
        writable: true,
        has_add: !add_messages,
        has_add_messages: add_messages,
        extraction: Some(
            ExtractionConfig::default()
                .with_trigger([Arc::new(InvocationTrigger::new()) as Arc<dyn crate::memory::ExtractionTrigger>]),
        ),
        ..MockStore::new("personal")
    })
}

fn coordinator(store: &Arc<MockStore>) -> ExtractionCoordinator {
    let binding = ExtractionBinding {
        store: store.clone(),
        config: resolve_extraction_config(store.extraction.clone(), store.as_ref()).unwrap(),
    };
    ExtractionCoordinator::new(vec![binding], Arc::new(MockModel::new()), Arc::new(Tracer::default()))
}

/// Returns two fixed entries.
struct TwoFacts;

#[async_trait]
impl Extractor for TwoFacts {
    async fn extract(&self, _messages: &[Message], _context: ExtractorContext) -> Result<Vec<ExtractionResult>> {
        Ok(vec![
            ExtractionResult::new("fact one"),
            ExtractionResult::new("fact two"),
        ])
    }
}

// search

#[tokio::test]
async fn starts_and_ends_a_search_span_with_the_retrieved_entries() {
    let capture = capture_spans();
    let manager = manager_of(vec![store_with("personal", &["x"])], false);

    let found = manager
        .search_with("preferences", MemorySearchOptions::default())
        .await
        .unwrap();

    assert_eq!(found.len(), 1);
    let span = capture.span("memory.search");
    assert_eq!(attr_i64(&span, "memory.store.failure_count"), Some(0));
    assert_eq!(results(&span), json!([{"content": "x", "storeName": "personal"}]));
}

#[tokio::test]
async fn counts_a_per_store_failure_but_ends_the_span_ok_not_an_error() {
    let capture = capture_spans();
    let bad = Arc::new(MockStore {
        search_error: Some("boom".into()),
        ..MockStore::new("bad")
    });
    let manager = manager_of(vec![store_with("good", &["hit"]), bad], false);

    let found = manager.search_with("q", MemorySearchOptions::default()).await.unwrap();

    assert_eq!(found.len(), 1);
    let span = capture.span("memory.search");
    assert_eq!(attr_i64(&span, "memory.store.failure_count"), Some(1));
    assert_eq!(span.status, opentelemetry::trace::Status::Ok);
}

#[tokio::test]
async fn ends_the_span_with_an_error_when_a_named_store_is_unknown() {
    let capture = capture_spans();
    let manager = manager_of(vec![store_with("personal", &[])], false);

    let error = manager
        .search_with(
            "q",
            MemorySearchOptions {
                stores: Some(vec!["missing".into()]),
                ..MemorySearchOptions::default()
            },
        )
        .await
        .unwrap_err();

    assert_eq!(error.to_string(), "MemoryManager: store 'missing' not found");
    assert!(is_error(
        &capture.span("memory.search"),
        "MemoryManager: store 'missing' not found"
    ));
}

// add

#[tokio::test]
async fn starts_and_ends_an_add_span_on_success() {
    let capture = capture_spans();
    let manager = manager_of(vec![Arc::new(MockStore::new("personal").writable())], false);

    manager
        .add_with("remember this", MemoryAddOptions::default())
        .await
        .unwrap();

    let span = capture.span("memory.add");
    assert_eq!(span.status, opentelemetry::trace::Status::Ok);
    assert_eq!(attr_i64(&span, "memory.store.failure_count"), Some(0));
}

#[tokio::test]
async fn ends_the_span_with_the_aggregate_error_when_a_write_fails() {
    let capture = capture_spans();
    let store = Arc::new(MockStore::new("personal").writable().failing_adds("disk full"));
    let manager = manager_of(vec![store], false);

    let error = manager
        .add_with("remember this", MemoryAddOptions::default())
        .await
        .unwrap_err();

    assert_eq!(error.to_string(), "MemoryManager: store writes failed: personal");
    let span = capture.span("memory.add");
    assert_eq!(attr_i64(&span, "memory.store.failure_count"), Some(1));
    assert!(is_error(&span, "MemoryManager: store writes failed: personal"));
}

#[tokio::test]
async fn forces_a_root_span_for_the_detached_fire_and_forget_path() {
    let capture = capture_spans();
    let manager = manager_of(vec![Arc::new(MockStore::new("personal").writable())], false);
    let options = || MemoryAddOptions {
        stores: Some(vec!["personal".into()]),
        ..MemoryAddOptions::default()
    };

    async {
        manager.inner.add("detached", options(), true).await.ok();
        manager.inner.add("attached", options(), false).await.ok();
    }
    .instrument(tracing::info_span!("outer"))
    .await;

    let outer = capture.span("outer").span_context.span_id();
    let parents: Vec<SpanId> = capture
        .named("memory.add")
        .iter()
        .map(|span| span.parent_span_id)
        .collect();
    assert_eq!(parents, [SpanId::INVALID, outer]);
}

// injection

#[tokio::test]
async fn ends_the_inject_span_injected_true_with_the_entry_count_on_the_happy_path() {
    let capture = capture_spans();
    let store = Arc::new(MockStore {
        entries: vec![MemoryEntry::new("likes dark mode").with_store_name("personal")],
        ..MockStore::new("personal")
    });
    let manager = manager_of(vec![store], true);

    let rendered = manager.provide_memory_context(&[Message::user("hi")]).await.unwrap();

    assert!(rendered.unwrap().contains("dark mode"));
    let span = capture.span("memory.inject");
    assert_eq!(injected(&span), Some(Value::Bool(true)));
    assert_eq!(attr_i64(&span, "memory.entry.count"), Some(1));
    let search = capture.span("memory.search");
    assert_eq!(search.parent_span_id, span.span_context.span_id());
}

#[tokio::test]
async fn ends_injected_false_when_no_query_can_be_derived() {
    let capture = capture_spans();
    let manager = manager_of(vec![store_with("personal", &[])], true);

    let rendered = manager.provide_memory_context(&[]).await.unwrap();

    assert_eq!(rendered, None);
    assert_eq!(injected(&capture.span("memory.inject")), Some(Value::Bool(false)));
}

#[tokio::test]
async fn fails_open_with_format_error_true_when_the_format_callback_throws() {
    let capture = capture_spans();
    let store = Arc::new(MockStore {
        entries: vec![MemoryEntry::new("x").with_store_name("personal")],
        ..MockStore::new("personal")
    });
    let manager = with_format(store, MemoryFormat::new(|_| Err("bad format".into())));

    let rendered = manager.provide_memory_context(&[Message::user("hi")]).await.unwrap();

    assert_eq!(rendered, None);
    let span = capture.span("memory.inject");
    assert_eq!(injected(&span), Some(Value::Bool(false)));
    assert_eq!(attr(&span, "memory.inject.format_error"), Some(Value::Bool(true)));
}

#[tokio::test]
async fn fails_open_ends_injected_false_when_the_query_callback_throws() {
    let capture = capture_spans();
    let manager = with_query(
        store_with("personal", &[]),
        MemoryQuery::new(|_| Err("query exploded".into())),
    );

    let rendered = manager.provide_memory_context(&[Message::user("hi")]).await.unwrap();

    assert_eq!(rendered, None);
    assert_eq!(injected(&capture.span("memory.inject")), Some(Value::Bool(false)));
}

// extraction coordinator

#[tokio::test]
async fn starts_a_root_extract_span_and_ends_it_ok_on_a_successful_save() {
    let capture = capture_spans();
    let store = extraction_store(true);
    let coordinator = coordinator(&store);
    coordinator.record(Message::user("remember dark mode"));

    coordinator.process(0, None).await;

    let span = capture.span("memory.extract");
    assert_eq!(span.status, opentelemetry::trace::Status::Ok);
    assert_eq!(span.parent_span_id, SpanId::INVALID);
    assert_eq!(store.batches().len(), 1);
}

#[tokio::test]
async fn ends_the_extract_span_with_the_error_and_swallows_the_failure() {
    let capture = capture_spans();
    let store = extraction_store(true);
    *store.add_messages_error.lock().unwrap() = Some("backend down".into());
    let coordinator = coordinator(&store);
    coordinator.record(Message::user("remember dark mode"));

    coordinator.process(0, None).await;

    assert!(is_error(&capture.span("memory.extract"), "backend down"));
}

#[tokio::test]
async fn creates_no_span_when_there_are_no_fresh_messages() {
    let capture = capture_spans();
    let store = extraction_store(true);
    let coordinator = coordinator(&store);

    coordinator.process(0, None).await;

    assert!(capture.named("memory.extract").is_empty());
}

#[tokio::test]
async fn passes_the_written_entry_count_to_the_span_end_extractor_route() {
    let capture = capture_spans();
    let store = Arc::new(MockStore {
        writable: true,
        has_add: true,
        extraction: Some(
            ExtractionConfig::default()
                .with_trigger([Arc::new(InvocationTrigger::new()) as Arc<dyn crate::memory::ExtractionTrigger>])
                .with_extractor(Arc::new(TwoFacts)),
        ),
        ..MockStore::new("personal")
    });
    let coordinator = coordinator(&store);
    coordinator.record(Message::user("remember two things"));

    coordinator.process(0, None).await;

    let span = capture.span("memory.extract");
    assert_eq!(attr_i64(&span, "memory.entry.count"), Some(2));
    assert_eq!(
        attr(&span, "memory.extractor")
            .map(|value| value.as_str().into_owned())
            .as_deref(),
        Some("Extractor")
    );
}

#[tokio::test]
async fn records_entry_count_0_when_all_messages_are_filtered_out() {
    let capture = capture_spans();
    let store = extraction_store(true);
    let coordinator = coordinator(&store);
    coordinator.record(Message::new(
        Role::User,
        vec![ToolResultBlock::new("1", ToolResultStatus::Success, Vec::new()).into()],
    ));

    coordinator.process(0, None).await;

    assert!(store.batches().is_empty());
    let span = capture.span("memory.extract");
    assert_eq!(attr_i64(&span, "memory.entry.count"), Some(0));
    assert_eq!(attr_i64(&span, "memory.message.filtered_count"), Some(1));
}

// agent

/// The built-in triggers fire from `AfterInvocationEvent`, after the agent span has ended, so the
/// extraction links to the span current around the invocation.
#[tokio::test]
async fn links_an_agent_runs_extract_span_to_the_span_current_when_its_trigger_fires() {
    let capture = capture_spans();
    let store = extraction_store(true);
    let manager = manager_of(vec![store.clone()], false);
    let mut agent = crate::Agent::builder()
        .model(MockModel::new().with_turn("Noted"))
        .memory_manager(manager.clone())
        .printer(false)
        .build()
        .unwrap();

    agent
        .invoke("remember dark mode")
        .instrument(tracing::info_span!("request"))
        .await
        .unwrap();
    manager.flush().await;

    let request = capture.span("request");
    let extract = capture.span("memory.extract");
    assert_eq!(store.batches().len(), 1);
    assert_eq!(extract.parent_span_id, SpanId::INVALID);
    assert_eq!(extract.links.links.len(), 1);
    assert_eq!(extract.links.links[0].span_context, request.span_context);
    assert_eq!(
        capture.span("invoke_agent Strands Agent").parent_span_id,
        request.span_context.span_id()
    );
}
