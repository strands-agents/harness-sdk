use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{Value, json};

use super::*;
use crate::agent::InvocationState;
use crate::hooks::{AfterInvocationEvent, MessageAddedEvent};
use crate::memory::{
    ExtractionResult, ExtractionTrigger, Extractor, ExtractorContext, InvocationTrigger, MemoryAddOptions,
    MemoryManager, MemoryManagerConfig, MemorySearchOptions,
};
use crate::plugins::Plugin;
use crate::types::Message;

fn file_path(dir: &tempfile::TempDir) -> PathBuf {
    dir.path().join("notes.json")
}

fn config(path: PathBuf) -> TestMemoryStoreConfig {
    TestMemoryStoreConfig {
        path: Some(path),
        ..TestMemoryStoreConfig::new("notes")
    }
}

fn store_at(path: PathBuf) -> TestMemoryStore {
    TestMemoryStore::new(config(path)).unwrap()
}

async fn search(store: &TestMemoryStore, query: &str) -> Vec<MemoryEntry> {
    store.search(query, SearchOptions::default()).await.unwrap()
}

fn read_file(path: &PathBuf) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn score(entry: &MemoryEntry) -> Value {
    entry.metadata.as_ref().unwrap()[RELEVANCE_SCORE_KEY].clone()
}

fn error_of(config: TestMemoryStoreConfig) -> String {
    TestMemoryStore::new(config).unwrap_err().to_string()
}

// --- constructor -------------------------------------------------------------------------------

#[test]
fn is_writable_by_default() {
    assert!(
        TestMemoryStore::new(TestMemoryStoreConfig::new("notes"))
            .unwrap()
            .writable()
    );
}

#[test]
fn honors_an_explicit_writable_false() {
    let store = TestMemoryStore::new(TestMemoryStoreConfig {
        writable: Some(false),
        ..TestMemoryStoreConfig::new("notes")
    })
    .unwrap();
    assert!(!store.writable());
}

#[test]
fn exposes_name_description_and_max_search_results() {
    let store = TestMemoryStore::new(TestMemoryStoreConfig {
        description: Some("my notes".into()),
        max_search_results: Some(7),
        ..TestMemoryStoreConfig::new("notes")
    })
    .unwrap();
    assert_eq!(store.name(), "notes");
    assert_eq!(store.description(), Some("my notes"));
    assert_eq!(MemoryStore::max_search_results(&store), Some(7));
}

#[test]
fn throws_when_max_search_results_is_less_than_1() {
    let config = TestMemoryStoreConfig {
        max_search_results: Some(0),
        ..TestMemoryStoreConfig::new("notes")
    };
    assert_eq!(
        error_of(config),
        "TestMemoryStore: maxSearchResults must be at least 1."
    );
}

#[test]
fn throws_when_name_is_empty() {
    assert_eq!(
        error_of(TestMemoryStoreConfig::new("   ")),
        "TestMemoryStore: name must not be empty."
    );
}

#[test]
fn throws_when_an_explicit_path_is_empty() {
    let config = TestMemoryStoreConfig {
        path: Some(PathBuf::from("   ")),
        ..TestMemoryStoreConfig::new("notes")
    };
    assert_eq!(error_of(config), "TestMemoryStore: path must not be empty.");
}

#[test]
fn does_no_filesystem_io_on_construction() {
    let dir = tempfile::tempdir().unwrap();
    store_at(file_path(&dir));
    assert!(!file_path(&dir).exists());
}

// --- add ---------------------------------------------------------------------------------------

#[tokio::test]
async fn throws_when_the_store_is_not_writable() {
    let dir = tempfile::tempdir().unwrap();
    let store = TestMemoryStore::new(TestMemoryStoreConfig {
        writable: Some(false),
        ..config(file_path(&dir))
    })
    .unwrap();
    let error = store.add("fact", None).await.unwrap_err();
    assert!(error.to_string().contains("store is not writable"));
}

#[tokio::test]
async fn throws_on_empty_or_whitespace_content() {
    let dir = tempfile::tempdir().unwrap();
    let error = store_at(file_path(&dir)).add("   ", None).await.unwrap_err();
    assert_eq!(error.to_string(), "TestMemoryStore: content must not be empty.");
}

#[tokio::test]
async fn returns_an_id_for_stored_content() {
    let dir = tempfile::tempdir().unwrap();
    let result = store_at(file_path(&dir))
        .add("user prefers dark mode", None)
        .await
        .unwrap();
    assert!(!result.id.is_empty());
}

#[tokio::test]
async fn deduplicates_identical_content_returning_the_existing_id() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_at(file_path(&dir));
    let first = store.add("user prefers dark mode", None).await.unwrap();
    let second = store.add("user prefers dark mode", None).await.unwrap();
    assert_eq!(second.id, first.id);
    assert_eq!(search(&store, "dark mode preferences").await.len(), 1);
}

#[tokio::test]
async fn persists_a_human_readable_json_array_to_disk() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_at(file_path(&dir));
    store
        .add("user prefers dark mode", json!({"source": "user"}).as_object().cloned())
        .await
        .unwrap();
    let raw = std::fs::read_to_string(file_path(&dir)).unwrap();
    assert!(raw.contains("\n  "));
    let parsed: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(parsed.as_array().unwrap().len(), 1);
    assert_eq!(parsed[0]["content"], "user prefers dark mode");
    assert_eq!(parsed[0]["metadata"], json!({"source": "user"}));
    assert!(parsed[0]["id"].as_str().is_some_and(|id| !id.is_empty()));
    assert!(parsed[0]["createdAt"].as_str().is_some_and(|at| !at.is_empty()));
}

#[tokio::test]
async fn writes_record_keys_in_the_ts_order() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_at(file_path(&dir));
    store
        .add("hello world", json!({"source": "user"}).as_object().cloned())
        .await
        .unwrap();
    let record = read_file(&file_path(&dir))[0].clone();
    let keys: Vec<&String> = record.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["id", "content", "createdAt", "metadata"]);
}

// --- search ------------------------------------------------------------------------------------

#[tokio::test]
async fn throws_when_search_max_search_results_is_less_than_1() {
    let dir = tempfile::tempdir().unwrap();
    let options = SearchOptions {
        max_search_results: Some(0),
    };
    let error = store_at(file_path(&dir)).search("q", options).await.unwrap_err();
    assert_eq!(
        error.to_string(),
        "TestMemoryStore: maxSearchResults must be at least 1."
    );
}

#[tokio::test]
async fn returns_no_results_for_an_empty_or_token_less_query() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_at(file_path(&dir));
    store.add("user prefers dark mode", None).await.unwrap();
    assert!(search(&store, "").await.is_empty());
    assert!(search(&store, "   ...  ").await.is_empty());
}

#[tokio::test]
async fn ranks_higher_token_overlap_first_and_exposes_relevance_score() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_at(file_path(&dir));
    store.add("the cat sat on the mat", None).await.unwrap();
    store.add("the cat chased the dog in the park", None).await.unwrap();
    let results = search(&store, "cat dog park").await;
    assert_eq!(results.len(), 2);
    assert_eq!(results[0].content, "the cat chased the dog in the park");
    assert_eq!(score(&results[0]), json!(3));
    assert_eq!(score(&results[1]), json!(1));
}

#[tokio::test]
async fn excludes_records_with_no_token_overlap() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_at(file_path(&dir));
    store.add("the cat sat on the mat", None).await.unwrap();
    store.add("a completely unrelated note", None).await.unwrap();
    let results = search(&store, "cat").await;
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].content, "the cat sat on the mat");
}

#[tokio::test]
async fn breaks_ties_by_recency_most_recent_first() {
    let dir = tempfile::tempdir().unwrap();
    let records = json!([
        {"id": "a", "content": "coffee is great", "createdAt": "2026-01-01T00:00:00.000Z"},
        {"id": "b", "content": "coffee is bitter", "createdAt": "2026-01-02T00:00:00.000Z"}
    ]);
    std::fs::write(file_path(&dir), records.to_string()).unwrap();
    let results = search(&store_at(file_path(&dir)), "coffee").await;
    assert_eq!(results[0].content, "coffee is bitter");
    assert_eq!(results[1].content, "coffee is great");
}

#[tokio::test]
async fn caps_results_to_max_search_results() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_at(file_path(&dir));
    for content in ["alpha match", "beta match", "gamma match"] {
        store.add(content, None).await.unwrap();
    }
    let options = SearchOptions {
        max_search_results: Some(2),
    };
    assert_eq!(store.search("match", options).await.unwrap().len(), 2);
}

#[tokio::test]
async fn tokenizes_non_ascii_content_as_whole_words_unicode_aware_matching_python() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_at(file_path(&dir));
    store.add("the café in 日本 is naïve", None).await.unwrap();
    assert_eq!(search(&store, "café").await.len(), 1);
    assert_eq!(search(&store, "日本").await.len(), 1);
}

// --- persistence -------------------------------------------------------------------------------

#[tokio::test]
async fn recalls_entries_from_a_fresh_instance_pointed_at_the_same_file_survives_restart() {
    let dir = tempfile::tempdir().unwrap();
    store_at(file_path(&dir))
        .add("user lives in Berlin", None)
        .await
        .unwrap();
    let results = search(&store_at(file_path(&dir)), "where does the user live").await;
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].content, "user lives in Berlin");
}

#[tokio::test]
async fn is_ephemeral_when_persist_is_false_no_file_a_fresh_instance_forgets() {
    let dir = tempfile::tempdir().unwrap();
    let ephemeral = || {
        TestMemoryStore::new(TestMemoryStoreConfig {
            persist: Some(false),
            ..config(file_path(&dir))
        })
        .unwrap()
    };
    ephemeral().add("ephemeral fact", None).await.unwrap();
    assert!(!file_path(&dir).exists());
    assert!(search(&ephemeral(), "ephemeral fact").await.is_empty());
}

#[tokio::test]
async fn starts_empty_when_the_backing_file_is_missing() {
    let dir = tempfile::tempdir().unwrap();
    assert!(search(&store_at(file_path(&dir)), "anything").await.is_empty());
}

#[test]
fn defaults_to_a_sanitized_path_under_home_strands_memory_when_no_path_is_given() {
    let home = PathBuf::from("/home/user");
    assert_eq!(default_dir(&home), PathBuf::from("/home/user/.strands/memory"));
    assert_eq!(format!("{}.json", sanitize_name("../weird/name")), "__weird_name.json");
    assert_eq!(sanitize_name("a😀b"), "a__b");
}

async fn search_error(contents: &str) -> String {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(file_path(&dir), contents).unwrap();
    store_at(file_path(&dir))
        .search("anything", SearchOptions::default())
        .await
        .unwrap_err()
        .to_string()
}

#[tokio::test]
async fn throws_a_clear_error_on_a_corrupt_backing_file() {
    assert_eq!(
        search_error("not json{").await,
        "TestMemoryStore: invalid JSON in notes.json"
    );
}

#[tokio::test]
async fn throws_a_clear_error_on_a_valid_but_wrong_shape_backing_file() {
    assert!(search_error("{}").await.contains("expected a JSON array"));
}

#[tokio::test]
async fn throws_a_clear_error_on_a_malformed_record() {
    assert!(
        search_error(r#"[{"foo": "bar"}]"#)
            .await
            .contains("each record must have string")
    );
}

#[tokio::test]
async fn throws_a_clear_error_on_a_record_whose_metadata_is_not_an_object() {
    let records = r#"[{"id": "a", "content": "hi", "createdAt": "2026-01-01T00:00:00.000Z", "metadata": "oops"}]"#;
    assert!(
        search_error(records)
            .await
            .contains("'metadata', when present, must be a JSON object")
    );
}

#[tokio::test]
async fn accepts_a_record_with_null_metadata_treated_as_absent_matching_python() {
    let dir = tempfile::tempdir().unwrap();
    let records = r#"[{"id": "a", "content": "hi there", "createdAt": "2026-01-01T00:00:00.000Z", "metadata": null}]"#;
    std::fs::write(file_path(&dir), records).unwrap();
    let results = search(&store_at(file_path(&dir)), "hi").await;
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].metadata, json!({"_relevanceScore": 1}).as_object().cloned());
}

#[tokio::test]
async fn throws_a_clear_error_when_the_path_is_unreachable() {
    let dir = tempfile::tempdir().unwrap();
    let blocker = dir.path().join("blocker");
    std::fs::write(&blocker, "not a directory").unwrap();
    let error = store_at(blocker.join("notes.json"))
        .add("user prefers dark mode", None)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("Failed to"), "{error}");
}

#[tokio::test]
async fn keeps_all_entries_when_many_writes_happen_concurrently() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(store_at(file_path(&dir)));
    let writes = (0..10).map(|index| {
        let store = store.clone();
        async move { store.add(&format!("fact number {index}"), None).await.unwrap() }
    });
    futures::future::join_all(writes).await;
    assert_eq!(read_file(&file_path(&dir)).as_array().unwrap().len(), 10);
}

#[tokio::test]
async fn reflects_a_just_added_record_when_a_search_races_the_first_add() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_at(file_path(&dir));
    let (added, _) = futures::join!(
        store.add("zebra giraffe", None),
        store.search("apple", SearchOptions::default())
    );
    added.unwrap();
    let results = search(&store, "zebra").await;
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].content, "zebra giraffe");
}

// --- cross-SDK interop -------------------------------------------------------------------------

#[tokio::test]
async fn loads_a_file_written_in_the_shared_camel_case_format() {
    let dir = tempfile::tempdir().unwrap();
    let written = json!([{
        "id": "019ed65a-fd27-746c-aa3a-693a4a5434df",
        "content": "the user prefers dark mode",
        "metadata": {"source": "py"},
        "createdAt": "2026-01-02T00:00:00.000Z"
    }]);
    std::fs::write(file_path(&dir), written.to_string()).unwrap();
    let results = search(&store_at(file_path(&dir)), "dark mode preference").await;
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].content, "the user prefers dark mode");
    assert_eq!(results[0].metadata.as_ref().unwrap()["source"], "py");
    assert_eq!(score(&results[0]), json!(2));
}

#[tokio::test]
async fn writes_the_shared_camel_case_format_with_a_z_suffixed_millisecond_timestamp() {
    let dir = tempfile::tempdir().unwrap();
    store_at(file_path(&dir)).add("hello world", None).await.unwrap();
    let record = read_file(&file_path(&dir))[0].clone();
    let mut keys: Vec<&String> = record.as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(keys, ["content", "createdAt", "id"]);
    let created_at = record["createdAt"].as_str().unwrap();
    assert_eq!(created_at.len(), 24);
    assert!(created_at.ends_with('Z') && created_at.as_bytes()[19] == b'.');
}

// --- MemoryManager integration -----------------------------------------------------------------

#[tokio::test]
async fn stamps_store_name_on_results_returned_through_the_manager() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_at(file_path(&dir));
    store.add("user prefers dark mode", None).await.unwrap();
    let manager = MemoryManager::new(MemoryManagerConfig {
        stores: vec![Arc::new(store)],
        ..Default::default()
    })
    .unwrap();
    let results = manager
        .search_with("dark mode", MemorySearchOptions::default())
        .await
        .unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].store_name.as_deref(), Some("notes"));
}

#[tokio::test]
async fn writes_through_the_manager_add_api() {
    let dir = tempfile::tempdir().unwrap();
    let manager = MemoryManager::new(MemoryManagerConfig {
        stores: vec![Arc::new(store_at(file_path(&dir)))],
        add_tool_config: Some(true.into()),
        ..Default::default()
    })
    .unwrap();
    manager
        .add_with("user likes coffee", MemoryAddOptions::default())
        .await
        .unwrap();
    assert_eq!(read_file(&file_path(&dir)).as_array().unwrap().len(), 1);
}

#[derive(Default)]
struct FixedExtractor {
    calls: Mutex<usize>,
}

#[async_trait]
impl Extractor for FixedExtractor {
    async fn extract(&self, _messages: &[Message], _context: ExtractorContext) -> crate::Result<Vec<ExtractionResult>> {
        *self.calls.lock().unwrap() += 1;
        Ok(vec![ExtractionResult::new("user prefers dark mode")])
    }
}

#[tokio::test]
async fn ingests_extracted_facts_through_add_when_extraction_fires_client_side_extractor() {
    let dir = tempfile::tempdir().unwrap();
    let extractor = Arc::new(FixedExtractor::default());
    let trigger: Arc<dyn ExtractionTrigger> = Arc::new(InvocationTrigger::new());
    let store = TestMemoryStore::new(TestMemoryStoreConfig {
        extraction: Some(
            ExtractionConfig::default()
                .with_trigger([trigger])
                .with_extractor(extractor.clone())
                .into(),
        ),
        ..config(file_path(&dir))
    })
    .unwrap();
    let manager = MemoryManager::new(MemoryManagerConfig {
        stores: vec![Arc::new(store)],
        ..Default::default()
    })
    .unwrap();
    let mut agent = crate::test_support::local_agent();
    manager.init_agent(&mut agent).await.unwrap();

    let hooks = agent.hooks().clone();
    let mut added = MessageAddedEvent::new(&mut agent, InvocationState::new(), Message::user("I like dark mode"));
    hooks.invoke(&mut added).await.unwrap();
    drop(added);
    let mut after = AfterInvocationEvent::new(&mut agent, InvocationState::new());
    hooks.invoke(&mut after).await.unwrap();
    drop(after);
    manager.flush().await;

    assert_eq!(*extractor.calls.lock().unwrap(), 1);
    let parsed = read_file(&file_path(&dir));
    assert_eq!(parsed.as_array().unwrap().len(), 1);
    assert_eq!(parsed[0]["content"], "user prefers dark mode");
}
