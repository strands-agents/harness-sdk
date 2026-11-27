use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::json;

use super::*;
use crate::error::Error;
use crate::memory::{ExtractorContext, MemoryStore, SearchOptions};
use crate::storage::search::SearchStrategy;
use crate::storage::{InMemoryStorage, InMemoryStorageConfig, StorageSearchResult};
use crate::test_support::record_logs;
use crate::testing::MockModel;
use crate::types::{JsonObject, SystemPrompt};

fn backend() -> Arc<InMemoryStorage> {
    Arc::new(InMemoryStorage::new())
}

fn store_on(name: &str, storage: Arc<dyn Storage>) -> FileMemoryStore {
    FileMemoryStore::new(FileMemoryStoreConfig {
        storage: Some(storage),
        ..FileMemoryStoreConfig::new(name)
    })
    .unwrap()
}

/// The default store: `test-store` with a description, on `storage`.
fn setup() -> (Arc<InMemoryStorage>, FileMemoryStore) {
    let storage = backend();
    let store = FileMemoryStore::new(FileMemoryStoreConfig {
        description: Some("A test file memory store".into()),
        storage: Some(storage.clone()),
        ..FileMemoryStoreConfig::new("test-store")
    })
    .unwrap();
    (storage, store)
}

async fn read_text(storage: &InMemoryStorage, key: &str) -> Option<String> {
    storage
        .read(key)
        .await
        .unwrap()
        .map(|bytes| String::from_utf8(bytes).unwrap())
}

async fn scoped_keys(storage: &InMemoryStorage) -> Vec<String> {
    storage.namespace("memory/test-store").unwrap().list("").await.unwrap()
}

async fn search(store: &FileMemoryStore, query: &str) -> Vec<MemoryEntry> {
    store.search(query, SearchOptions::default()).await.unwrap()
}

fn contents(entries: &[MemoryEntry]) -> Vec<&str> {
    entries.iter().map(|entry| entry.content.as_str()).collect()
}

fn paths(entries: &[MemoryEntry]) -> Vec<String> {
    entries
        .iter()
        .map(|entry| entry.metadata.as_ref().unwrap()["path"].as_str().unwrap().to_owned())
        .collect()
}

fn metadata(path: &str, score: f64) -> JsonObject {
    json!({"path": path, "score": score}).as_object().cloned().unwrap()
}

type ReadFn = Box<dyn Fn(&str) -> crate::Result<Option<Vec<u8>>> + Send + Sync>;

/// A backend scripted by closures over keys.
struct ScriptedStorage {
    keys: Vec<&'static str>,
    read: ReadFn,
    search: Option<Vec<StorageSearchResult>>,
    reads: AtomicUsize,
}

impl ScriptedStorage {
    fn new(read: impl Fn(&str) -> crate::Result<Option<Vec<u8>>> + Send + Sync + 'static) -> Self {
        Self {
            keys: Vec::new(),
            read: Box::new(read),
            search: None,
            reads: AtomicUsize::new(0),
        }
    }
}

#[async_trait]
impl Storage for ScriptedStorage {
    async fn write(&self, _key: &str, _data: &[u8]) -> crate::Result<()> {
        Ok(())
    }

    async fn read(&self, key: &str) -> crate::Result<Option<Vec<u8>>> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        (self.read)(key)
    }

    async fn delete(&self, _key: &str) -> crate::Result<()> {
        Ok(())
    }

    async fn list(&self, _prefix: &str) -> crate::Result<Vec<String>> {
        Ok(self.keys.iter().map(|key| (*key).to_owned()).collect())
    }

    async fn search(&self, _query: &str) -> Option<crate::Result<Vec<StorageSearchResult>>> {
        self.search.clone().map(Ok)
    }
}

/// An in-memory backend whose keyword search reads through it, counting reads.
#[derive(Default)]
struct CountingStorage {
    inner: InMemoryStorage,
    reads: AtomicUsize,
    locked_prefix: Option<&'static str>,
}

#[async_trait]
impl Storage for CountingStorage {
    async fn write(&self, key: &str, data: &[u8]) -> crate::Result<()> {
        self.inner.write(key, data).await
    }

    async fn read(&self, key: &str) -> crate::Result<Option<Vec<u8>>> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        let locked = self
            .locked_prefix
            .is_some_and(|prefix| key.rsplit('/').next().is_some_and(|name| name.starts_with(prefix)));
        if locked {
            return Err(Error::other(format!("Failed to read '{key}' from local storage")));
        }
        self.inner.read(key).await
    }

    async fn delete(&self, key: &str) -> crate::Result<()> {
        self.inner.delete(key).await
    }

    async fn list(&self, prefix: &str) -> crate::Result<Vec<String>> {
        self.inner.list(prefix).await
    }

    async fn search(&self, query: &str) -> Option<crate::Result<Vec<StorageSearchResult>>> {
        Some(KeywordSearchStrategy.search(self, query).await)
    }
}

/// A strategy returning fixed results and recording the storage keys it saw.
struct FixedStrategy {
    results: Vec<StorageSearchResult>,
    calls: Mutex<Vec<(Vec<String>, String)>>,
}

#[async_trait]
impl SearchStrategy for FixedStrategy {
    async fn search(&self, storage: &dyn Storage, query: &str) -> crate::Result<Vec<StorageSearchResult>> {
        let keys = storage.list("").await?;
        self.calls.lock().unwrap().push((keys, query.to_owned()));
        Ok(self.results.clone())
    }
}

fn strategy_backend(results: Vec<StorageSearchResult>) -> (Arc<FixedStrategy>, Arc<InMemoryStorage>) {
    let strategy = Arc::new(FixedStrategy {
        results,
        calls: Mutex::default(),
    });
    let storage = Arc::new(InMemoryStorage::with_config(InMemoryStorageConfig {
        search_strategy: Some(strategy.clone()),
    }));
    (strategy, storage)
}

// --- constructor -------------------------------------------------------------------------------

#[test]
fn sets_name_and_description_from_config() {
    let (_, store) = setup();
    assert_eq!(store.name(), "test-store");
    assert_eq!(store.description(), Some("A test file memory store"));
}

#[test]
fn defaults_to_writable_true() {
    assert!(setup().1.writable());
}

#[test]
fn respects_writable_false_from_config() {
    let store = FileMemoryStore::new(FileMemoryStoreConfig {
        writable: Some(false),
        storage: Some(backend()),
        ..FileMemoryStoreConfig::new("readonly")
    })
    .unwrap();
    assert!(!store.writable());
}

#[tokio::test]
async fn uses_default_max_search_results_when_not_configured() {
    let (_, store) = setup();
    for index in 0..15 {
        store.add(&format!("Fact number {index}"), None).await.unwrap();
    }
    assert_eq!(search(&store, "fact").await.len(), 10);
}

#[tokio::test]
async fn respects_max_search_results_from_config() {
    let store = FileMemoryStore::new(FileMemoryStoreConfig {
        max_search_results: Some(2),
        storage: Some(backend()),
        ..FileMemoryStoreConfig::new("custom")
    })
    .unwrap();
    for index in 0..5 {
        store.add(&format!("Fact number {index}"), None).await.unwrap();
    }
    assert_eq!(search(&store, "fact").await.len(), 2);
}

#[test]
fn resolves_extraction_true_to_an_extraction_config_with_model_extractor() {
    let store = FileMemoryStore::new(FileMemoryStoreConfig {
        extraction: Some(true.into()),
        storage: Some(backend()),
        ..FileMemoryStoreConfig::new("ext")
    })
    .unwrap();
    assert!(store.extraction().unwrap().extractor.is_some());
}

#[test]
fn defaults_to_no_description_when_omitted() {
    assert_eq!(store_on("minimal", backend()).description(), None);
}

#[tokio::test]
async fn auto_scopes_keys_under_memory_name_on_the_raw_backend() {
    let (storage, store) = setup();
    store.add("User prefers dark mode", None).await.unwrap();
    assert!(
        read_text(&storage, "memory/test-store/user-prefers-dark-mode.md")
            .await
            .is_some()
    );
    assert!(read_text(&storage, "user-prefers-dark-mode.md").await.is_none());
}

#[tokio::test]
async fn scopes_distinct_named_stores_so_they_never_collide_on_a_shared_backend() {
    let storage = backend();
    let store_a = store_on("store-a", storage.clone());
    let store_b = store_on("store-b", storage.clone());
    store_a.add("User prefers dark mode", None).await.unwrap();
    store_b.add("User prefers light mode", None).await.unwrap();
    assert!(
        read_text(&storage, "memory/store-a/user-prefers-dark-mode.md")
            .await
            .unwrap()
            .contains("dark mode")
    );
    assert!(
        read_text(&storage, "memory/store-b/user-prefers-light-mode.md")
            .await
            .unwrap()
            .contains("light mode")
    );
    assert_eq!(search(&store_a, "mode").await.len(), 1);
    assert_eq!(search(&store_b, "mode").await.len(), 1);
}

#[tokio::test]
async fn does_not_re_scope_storage_that_is_already_namespaced() {
    let storage = backend();
    let pre_scoped = Arc::new(storage.namespace("memory/scoped").unwrap());
    let store = store_on("scoped", pre_scoped);
    store.add("User prefers dark mode", None).await.unwrap();
    assert!(
        read_text(&storage, "memory/scoped/user-prefers-dark-mode.md")
            .await
            .is_some()
    );
    assert!(
        read_text(&storage, "memory/scoped/memory/scoped/user-prefers-dark-mode.md")
            .await
            .is_none()
    );
}

// --- add ---------------------------------------------------------------------------------------

#[tokio::test]
async fn writes_plain_markdown_content() {
    let (storage, store) = setup();
    store.add("User prefers dark mode", None).await.unwrap();
    assert_eq!(
        read_text(&storage, "memory/test-store/user-prefers-dark-mode.md")
            .await
            .as_deref(),
        Some("User prefers dark mode")
    );
}

#[tokio::test]
async fn derives_filename_from_first_line_of_content() {
    let (storage, store) = setup();
    store
        .add("The user likes vim keybindings\nMore details here", None)
        .await
        .unwrap();
    assert_eq!(scoped_keys(&storage).await, ["the-user-likes-vim-keybindings.md"]);
}

#[tokio::test]
async fn truncates_derived_slug_at_50_characters() {
    let (storage, store) = setup();
    store
        .add(
            "this is a very long sentence that should be truncated when used as a filename slug for storage",
            None,
        )
        .await
        .unwrap();
    let keys = scoped_keys(&storage).await;
    assert!(keys[0].trim_end_matches(".md").len() <= 50);
}

#[tokio::test]
async fn appends_new_facts_to_an_existing_entry_with_the_same_slug() {
    let (storage, store) = setup();
    store.add("Python is great\nFast prototyping", None).await.unwrap();
    store.add("Python is great\nBut it has a GIL.", None).await.unwrap();
    assert_eq!(scoped_keys(&storage).await, ["python-is-great.md"]);
    assert_eq!(
        read_text(&storage, "memory/test-store/python-is-great.md")
            .await
            .as_deref(),
        Some("Python is great\nFast prototyping\nBut it has a GIL.")
    );
}

#[tokio::test]
async fn does_not_duplicate_content_when_new_entry_has_only_the_heading() {
    let (storage, store) = setup();
    store.add("Python is great\nFast prototyping", None).await.unwrap();
    store.add("Python is great", None).await.unwrap();
    assert_eq!(
        read_text(&storage, "memory/test-store/python-is-great.md")
            .await
            .as_deref(),
        Some("Python is great\nFast prototyping")
    );
}

#[tokio::test]
async fn uses_date_now_fallback_when_content_produces_empty_slug() {
    let (storage, store) = setup();
    store.add("!!!???", None).await.unwrap();
    let keys = scoped_keys(&storage).await;
    assert_eq!(keys.len(), 1);
    let stem = keys[0].strip_prefix("entry-").unwrap().strip_suffix(".md").unwrap();
    assert!(!stem.is_empty() && stem.bytes().all(|byte| byte.is_ascii_digit()));
}

#[tokio::test]
async fn slugifies_special_characters_out_of_the_filename() {
    let (storage, store) = setup();
    store.add("User's #1 testing rule!", None).await.unwrap();
    assert_eq!(scoped_keys(&storage).await, ["users-1-testing-rule.md"]);
}

#[tokio::test]
async fn returns_the_canonical_key() {
    let (_, store) = setup();
    assert_eq!(
        store.add("User prefers dark mode", None).await.unwrap(),
        "user-prefers-dark-mode.md"
    );
}

#[tokio::test]
async fn returns_the_same_key_on_append() {
    let (_, store) = setup();
    let first = store.add("Python is great\nFirst fact", None).await.unwrap();
    let second = store.add("Python is great\nSecond fact", None).await.unwrap();
    assert_eq!(first, second);
}

#[tokio::test]
async fn strips_markdown_heading_prefix_from_first_line_before_slugifying() {
    let (storage, store) = setup();
    store.add("# User preferences\nLikes dark mode", None).await.unwrap();
    assert_eq!(scoped_keys(&storage).await, ["user-preferences.md"]);
    assert_eq!(
        read_text(&storage, "memory/test-store/user-preferences.md")
            .await
            .as_deref(),
        Some("# User preferences\nLikes dark mode")
    );
}

#[tokio::test]
async fn strips_multiple_heading_levels() {
    let (storage, store) = setup();
    store.add("## Project setup\nTypeScript monorepo", None).await.unwrap();
    assert_eq!(scoped_keys(&storage).await, ["project-setup.md"]);
}

#[tokio::test]
async fn does_not_produce_trailing_hyphen_when_slug_truncates_at_word_boundary() {
    let (_, store) = setup();
    let key = store
        .add("aaaa bbbbb ccccc ddddd eeeee fffff ggggg hhhhh iiiii jjjjj", None)
        .await
        .unwrap();
    assert!(!key.ends_with("-.md"));
}

#[tokio::test]
async fn serializes_concurrent_appends_to_one_key() {
    let (storage, store) = setup();
    let store = Arc::new(store);
    let writes = (0..8).map(|index| {
        let store = store.clone();
        async move { store.add(&format!("Topic\nfact {index}"), None).await.unwrap() }
    });
    futures::future::join_all(writes).await;
    let text = read_text(&storage, "memory/test-store/topic.md").await.unwrap();
    assert_eq!(text.lines().count(), 9);
}

// --- search ------------------------------------------------------------------------------------

async fn seeded() -> (Arc<InMemoryStorage>, FileMemoryStore) {
    let (storage, store) = setup();
    for content in [
        "User prefers dark mode for all editors",
        "Testing philosophy: integration first, mock at boundaries",
        "Deploy process uses blue-green strategy",
    ] {
        store.add(content, None).await.unwrap();
    }
    (storage, store)
}

#[tokio::test]
async fn returns_matching_entries_by_keyword_in_content() {
    let (_, store) = seeded().await;
    assert_eq!(
        search(&store, "dark mode").await[0].content,
        "User prefers dark mode for all editors"
    );
}

#[tokio::test]
async fn matches_against_filenames() {
    let (_, store) = seeded().await;
    assert_eq!(
        search(&store, "deploy").await[0].content,
        "Deploy process uses blue-green strategy"
    );
}

#[tokio::test]
async fn is_case_insensitive() {
    let (_, store) = seeded().await;
    assert_eq!(
        search(&store, "DARK MODE").await[0].content,
        "User prefers dark mode for all editors"
    );
}

#[tokio::test]
async fn returns_empty_array_for_no_matches() {
    let (_, store) = seeded().await;
    assert!(search(&store, "quantum computing").await.is_empty());
}

#[tokio::test]
async fn returns_empty_array_for_empty_query() {
    let (_, store) = seeded().await;
    assert!(search(&store, "").await.is_empty());
}

#[tokio::test]
async fn returns_empty_array_for_whitespace_only_query() {
    let (_, store) = seeded().await;
    assert!(search(&store, "   ").await.is_empty());
}

#[tokio::test]
async fn respects_max_search_results_option() {
    let (_, store) = seeded().await;
    let options = SearchOptions {
        max_search_results: Some(1),
    };
    assert_eq!(store.search("process", options).await.unwrap().len(), 1);
}

#[tokio::test]
async fn ranks_results_by_number_of_distinct_matching_tokens() {
    let (_, store) = seeded().await;
    store
        .add("covers deploy, testing, and integration boundaries", None)
        .await
        .unwrap();
    assert_eq!(
        search(&store, "deploy testing integration").await[0].content,
        "covers deploy, testing, and integration boundaries"
    );
}

#[tokio::test]
async fn includes_metadata_path_on_results() {
    let (_, store) = seeded().await;
    assert_eq!(
        paths(&search(&store, "deploy").await)[0],
        "deploy-process-uses-blue-green-strategy.md"
    );
}

#[tokio::test]
async fn skips_keys_where_storage_returns_null() {
    let storage = ScriptedStorage {
        keys: vec!["memory/null-store/ghost.md"],
        ..ScriptedStorage::new(|_| Ok(None))
    };
    let store = store_on("null-store", Arc::new(storage));
    assert!(search(&store, "anything").await.is_empty());
}

#[tokio::test]
async fn skips_keys_where_storage_read_throws_and_still_returns_other_matches() {
    let storage = ScriptedStorage {
        keys: vec!["memory/throwing-store/broken.md", "memory/throwing-store/good.md"],
        ..ScriptedStorage::new(|key| {
            if key.contains("broken") {
                return Err(Error::other("EACCES: permission denied"));
            }
            Ok(Some(b"valid content about deploy".to_vec()))
        })
    };
    let store = store_on("throwing-store", Arc::new(storage));
    assert_eq!(
        contents(&search(&store, "deploy").await),
        ["valid content about deploy"]
    );
}

#[tokio::test]
async fn delegates_to_a_search_strategy_configured_on_the_storage_backend() {
    let (strategy, storage) = strategy_backend(vec![StorageSearchResult::new(
        "user-prefers-dark-mode-for-all-editors.md",
        0.9,
    )]);
    let store = store_on("strategy-store", storage);
    store.add("User prefers dark mode for all editors", None).await.unwrap();
    let results = search(&store, "editor theme").await;
    assert_eq!(
        *strategy.calls.lock().unwrap(),
        [(
            vec!["user-prefers-dark-mode-for-all-editors.md".to_owned()],
            "editor theme".to_owned()
        )]
    );
    assert_eq!(
        results,
        [MemoryEntry::new("User prefers dark mode for all editors")
            .with_metadata(metadata("user-prefers-dark-mode-for-all-editors.md", 0.9))]
    );
}

#[tokio::test]
async fn skips_an_unreadable_entry_instead_of_failing_the_search() {
    let storage = Arc::new(CountingStorage {
        locked_prefix: Some("locked-"),
        ..CountingStorage::default()
    });
    let store = store_on("test-store", storage);
    store.add("User prefers dark mode for all editors", None).await.unwrap();
    store
        .storage
        .write("locked-note-about-dark-mode.md", b"Locked note about dark mode")
        .await
        .unwrap();
    assert_eq!(
        contents(&search(&store, "dark mode").await),
        ["User prefers dark mode for all editors"]
    );
}

#[tokio::test]
async fn skips_a_result_whose_read_fails_when_the_backend_returns_keys_without_data() {
    let storage = ScriptedStorage {
        search: Some(vec![
            StorageSearchResult::new("memory/keys-only/locked.md", 2.0),
            StorageSearchResult::new("memory/keys-only/good.md", 1.0),
        ]),
        ..ScriptedStorage::new(|key| {
            if key.ends_with("locked.md") {
                return Err(Error::other(format!("Failed to read '{key}'")));
            }
            Ok(Some(b"good entry\n".to_vec()))
        })
    };
    let store = store_on("keys-only", Arc::new(storage));
    assert_eq!(
        search(&store, "anything").await,
        [MemoryEntry::new("good entry").with_metadata(metadata("good.md", 1.0))]
    );
}

#[tokio::test]
async fn fills_max_search_results_with_the_next_hit_when_a_higher_ranked_read_fails() {
    let storage = ScriptedStorage {
        search: Some(vec![
            StorageSearchResult::new("memory/fill/locked.md", 3.0),
            StorageSearchResult::new("memory/fill/a.md", 2.0),
            StorageSearchResult::new("memory/fill/b.md", 1.0),
            StorageSearchResult::new("memory/fill/c.md", 0.5),
        ]),
        ..ScriptedStorage::new(|key| {
            if key.ends_with("locked.md") {
                return Err(Error::other(format!("Failed to read '{key}'")));
            }
            Ok(Some(format!("{key} entry").into_bytes()))
        })
    };
    let store = FileMemoryStore::new(FileMemoryStoreConfig {
        max_search_results: Some(2),
        storage: Some(Arc::new(storage)),
        ..FileMemoryStoreConfig::new("fill")
    })
    .unwrap();
    assert_eq!(paths(&search(&store, "anything").await), ["a.md", "b.md"]);
}

#[tokio::test]
async fn logs_which_search_path_it_resolved() {
    let (_, store) = seeded().await;
    let (logs, _guard) = record_logs();
    search(&store, "dark mode").await;
    assert!(
        logs.text()
            .contains("store=<test-store>, path=<backend> | resolved search")
    );
}

#[tokio::test]
async fn reads_each_entry_once_with_the_default_keyword_search() {
    let storage = Arc::new(CountingStorage::default());
    let store = store_on("test-store", storage.clone());
    for content in [
        "User prefers dark mode for all editors",
        "Testing philosophy: integration first, mock at boundaries",
        "Deploy process uses blue-green strategy",
    ] {
        store.add(content, None).await.unwrap();
    }
    storage.reads.store(0, Ordering::SeqCst);
    let results = search(&store, "dark mode").await;
    assert_eq!(contents(&results), ["User prefers dark mode for all editors"]);
    assert_eq!(storage.reads.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn uses_data_returned_by_the_storages_search_without_re_reading_it() {
    let mut hit = StorageSearchResult::new("memory/searching-store/hit.md", 1.0);
    hit.data = Some(b"content from search\n".to_vec());
    let storage = Arc::new(ScriptedStorage {
        search: Some(vec![hit]),
        ..ScriptedStorage::new(|_| Ok(None))
    });
    let store = store_on("searching-store", storage.clone());
    assert_eq!(
        search(&store, "anything").await,
        [MemoryEntry::new("content from search").with_metadata(metadata("hit.md", 1.0))]
    );
    assert_eq!(storage.reads.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn applies_max_search_results_to_results_from_the_storage_backend() {
    let (_, storage) = strategy_backend(vec![
        StorageSearchResult::new("user-prefers-dark-mode-for-all-editors.md", 2.0),
        StorageSearchResult::new("deploy-process-uses-blue-green-strategy.md", 1.0),
    ]);
    let store = store_on("strategy-store", storage);
    store.add("User prefers dark mode for all editors", None).await.unwrap();
    store
        .add("Deploy process uses blue-green strategy", None)
        .await
        .unwrap();
    let options = SearchOptions {
        max_search_results: Some(1),
    };
    assert_eq!(
        paths(&store.search("anything", options).await.unwrap()),
        ["user-prefers-dark-mode-for-all-editors.md"]
    );
}

// --- extraction (key-aware extractor) ----------------------------------------------------------

fn extraction_store(
    name: &str,
    storage: Arc<dyn Storage>,
    extraction: Toggle<FileMemoryExtractionConfig>,
) -> FileMemoryStore {
    FileMemoryStore::new(FileMemoryStoreConfig {
        storage: Some(storage),
        extraction: Some(extraction),
        ..FileMemoryStoreConfig::new(name)
    })
    .unwrap()
}

fn empty_reply() -> MockModel {
    MockModel::new().with_turn("[]")
}

fn prompt_of(model: &MockModel) -> String {
    match &model.requests()[0].system_prompt {
        Some(SystemPrompt::Text(text)) => text.clone(),
        other => panic!("not a text system prompt: {other:?}"),
    }
}

async fn extract_with_default(store: &FileMemoryStore, text: &str, model: &MockModel) {
    let extractor = store.extraction().unwrap().extractor.unwrap();
    let context = ExtractorContext::default().with_default_model(Arc::new(model.clone()));
    extractor.extract(&[Message::user(text)], context).await.unwrap();
}

#[tokio::test]
async fn includes_existing_topic_headings_in_the_system_prompt() {
    let store = extraction_store("ext-test", backend(), true.into());
    store
        .add("User preferences\nPrefers dark mode\nUses vim", None)
        .await
        .unwrap();
    store.add("Project setup\nTypeScript monorepo", None).await.unwrap();
    let model = empty_reply();
    extract_with_default(&store, "I also prefer light themes", &model).await;
    let prompt = prompt_of(&model);
    assert!(prompt.contains("Existing topics:"));
    assert!(prompt.contains("user preferences"));
    assert!(prompt.contains("project setup"));
    assert!(prompt.contains("Reuse an existing topic heading"));
    assert!(!prompt.contains("Prefers dark mode"));
}

#[tokio::test]
async fn does_not_include_existing_topics_section_when_store_is_empty() {
    let store = extraction_store("ext-empty", backend(), true.into());
    let model = empty_reply();
    extract_with_default(&store, "Hello", &model).await;
    assert!(!prompt_of(&model).contains("Existing topics:"));
}

#[tokio::test]
async fn uses_the_configured_model_over_the_context_default_model() {
    let configured = empty_reply();
    let fallback = empty_reply();
    let store = extraction_store(
        "ext-model",
        backend(),
        FileMemoryExtractionConfig {
            model: Some(Arc::new(configured.clone())),
            ..Default::default()
        }
        .into(),
    );
    extract_with_default(&store, "I prefer light themes", &fallback).await;
    assert_eq!(configured.requests().len(), 1);
    assert_eq!(fallback.requests().len(), 0);
}

#[tokio::test]
async fn falls_back_to_the_context_default_model_when_no_model_is_configured() {
    let store = extraction_store("ext-fallback", backend(), true.into());
    let fallback = empty_reply();
    extract_with_default(&store, "I prefer light themes", &fallback).await;
    assert_eq!(fallback.requests().len(), 1);
}

#[tokio::test]
async fn builds_the_system_prompt_on_the_key_aware_heading_instruction() {
    let store = extraction_store("ext-prompt", backend(), true.into());
    let model = empty_reply();
    extract_with_default(&store, "Hello", &model).await;
    assert!(prompt_of(&model).contains("The first line is a markdown heading"));
}

#[tokio::test]
async fn overrides_the_framing_with_a_custom_system_prompt_but_keeps_the_output_contract() {
    let store = extraction_store(
        "ext-guidance",
        backend(),
        FileMemoryExtractionConfig {
            system_prompt: Some("Extract only trading preferences and risk tolerance.".into()),
            ..Default::default()
        }
        .into(),
    );
    let model = empty_reply();
    extract_with_default(&store, "I trade options", &model).await;
    let prompt = prompt_of(&model);
    assert!(prompt.contains("Extract only trading preferences and risk tolerance."));
    assert!(!prompt.contains("You extract durable facts worth remembering"));
    assert!(prompt.contains("The first line is a markdown heading"));
    assert!(prompt.contains("Return ONLY a JSON array"));
}

#[tokio::test]
async fn uses_a_supplied_extractor_verbatim_ignoring_model_and_system_prompt() {
    let custom_model = empty_reply();
    let custom: Arc<dyn Extractor> = Arc::new(ModelExtractor::new(ModelExtractorOptions {
        model: Some(Arc::new(custom_model.clone())),
        system_prompt: Some("Custom prompt.".into()),
    }));
    let store = extraction_store(
        "ext-custom",
        backend(),
        FileMemoryExtractionConfig {
            extractor: Some(custom.clone()),
            model: Some(Arc::new(empty_reply())),
            ..Default::default()
        }
        .into(),
    );
    assert!(Arc::ptr_eq(
        store.extraction().unwrap().extractor.as_ref().unwrap(),
        &custom
    ));
    extract_with_default(&store, "Hello", &empty_reply()).await;
    let prompt = prompt_of(&custom_model);
    assert!(prompt.starts_with("Custom prompt.\n\n"));
    assert!(!prompt.contains("The first line is a markdown heading"));
}
