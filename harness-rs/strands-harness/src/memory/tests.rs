//! The store and extraction model `default_store` builds, and the read-only view. The
//! `create_harness` memory cases are in the agent tests.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use strands::models::routing::{ModelRouter, ModelRouterOptions, RoutingCandidate};
use strands::models::{BaseModelConfig, Model};
use strands::plugins::Plugin;
use strands::testing::MockModel;
use strands::tools::ToolSource;

use super::*;
use crate::test_support::offline_env;

const DEFAULT: &str = "bedrock/global.anthropic.claude-opus-4-8";

fn options(dir: &Path) -> ResolveMemoryOptions {
    ResolveMemoryOptions {
        model: Some(DEFAULT.into()),
        dir: Some(dir.to_path_buf()),
        ..Default::default()
    }
}

fn tool_names(manager: &MemoryManager) -> Vec<String> {
    manager
        .get_tools()
        .into_iter()
        .flat_map(ToolSource::into_tools)
        .map(|tool| tool.name().to_owned())
        .collect()
}

fn mock(model_id: &str) -> Arc<dyn Model> {
    let model = MockModel::new();
    model
        .update_config(BaseModelConfig {
            model_id: Some(model_id.to_owned()),
            ..Default::default()
        })
        .unwrap();
    Arc::new(model)
}

struct Backing {
    initialized: AtomicUsize,
}

#[strands::async_trait]
impl MemoryStore for Backing {
    fn name(&self) -> &str {
        "backing"
    }

    fn description(&self) -> Option<&str> {
        Some("org knowledge")
    }

    fn max_search_results(&self) -> Option<usize> {
        Some(7)
    }

    fn writable(&self) -> bool {
        true
    }

    async fn search(&self, _query: &str, _options: SearchOptions) -> strands::Result<Vec<MemoryEntry>> {
        Ok(vec![MemoryEntry::new("recalled")])
    }

    fn implements_add(&self) -> bool {
        true
    }

    async fn initialize(&self) -> strands::Result<()> {
        self.initialized.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

#[cfg(feature = "bedrock")]
#[test]
fn builds_a_memory_manager_over_a_writable_file_memory_store_named_memory() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = default_store(&options(dir.path()), &offline_env()).unwrap();
    assert_eq!(store.name(), "memory");
    assert!(store.writable());
    resolve_memory(options(dir.path()), &offline_env()).unwrap();
}

#[cfg(feature = "bedrock")]
#[test]
fn exposes_search_memory_but_no_add_memory_tool() {
    let dir = tempfile::tempdir().unwrap();
    let names = tool_names(&resolve_memory(options(dir.path()), &offline_env()).unwrap());
    assert!(names.contains(&"search_memory".to_owned()));
    assert!(!names.contains(&"add_memory".to_owned()));
}

#[cfg(feature = "bedrock")]
#[test]
fn distills_facts_on_the_small_provider_model_not_the_main_model() {
    let dir = tempfile::tempdir().unwrap();
    let (_, model) = default_store(&options(dir.path()), &offline_env()).unwrap();
    assert_eq!(
        model.unwrap().model_id().as_deref(),
        Some("global.anthropic.claude-haiku-4-5-20251001-v1:0")
    );
}

#[test]
fn extracts_on_a_model_router_default_model() {
    let dir = tempfile::tempdir().unwrap();
    let candidates: Vec<RoutingCandidate> = vec![mock("fast").into(), mock("deep").into()];
    let router = ModelRouter::new(candidates, ModelRouterOptions::default()).unwrap();
    let options = ResolveMemoryOptions {
        model: Some(router.clone().into()),
        dir: Some(dir.path().to_path_buf()),
        ..Default::default()
    };
    let (_, model) = default_store(&options, &offline_env()).unwrap();
    assert!(Arc::ptr_eq(&model.unwrap(), &router.default_model()));
}

#[tokio::test]
async fn writes_memory_files_directly_under_the_memory_dir_not_a_nested_memory_path() {
    let dir = tempfile::tempdir().unwrap();
    let options = ResolveMemoryOptions {
        model: Some(mock("test-model").into()),
        dir: Some(dir.path().to_path_buf()),
        ..Default::default()
    };
    let (store, _) = default_store(&options, &offline_env()).unwrap();
    store.add("# Stack\nThe user works in TypeScript.", None).await.unwrap();
    let written = std::fs::read_to_string(dir.path().join("stack.md")).unwrap();
    assert!(written.contains("TypeScript"));
}

#[cfg(feature = "bedrock")]
#[test]
fn extracts_on_an_explicit_web_fetch_model_override_when_one_is_set() {
    let dir = tempfile::tempdir().unwrap();
    let options = ResolveMemoryOptions {
        web_fetch_model: Some("bedrock/us.amazon.nova-lite-v1:0".into()),
        ..options(dir.path())
    };
    let (_, model) = default_store(&options, &offline_env()).unwrap();
    assert_eq!(model.unwrap().model_id().as_deref(), Some("us.amazon.nova-lite-v1:0"));
}

#[test]
fn builds_a_recall_only_store_when_writable_is_false() {
    let dir = tempfile::tempdir().unwrap();
    let options = ResolveMemoryOptions {
        read_only: true,
        ..options(dir.path())
    };
    let (store, model) = default_store(&options, &offline_env()).unwrap();
    assert!(!store.writable());
    assert!(model.is_none());
    assert!(store.extraction().is_none());
    let names = tool_names(&resolve_memory(options, &offline_env()).unwrap());
    assert!(names.contains(&"search_memory".to_owned()));
}

#[tokio::test]
async fn wraps_consumer_stores_read_only_when_writable_is_false() {
    let backing = Arc::new(Backing {
        initialized: AtomicUsize::new(0),
    });
    let view = read_only(Arc::clone(&backing) as Arc<dyn MemoryStore>);
    assert_eq!(view.name(), "backing");
    assert_eq!(view.description(), Some("org knowledge"));
    assert_eq!(view.max_search_results(), Some(7));
    assert!(!view.writable());
    assert!(!view.implements_add());
    assert!(!view.implements_add_messages());
    assert!(view.extraction().is_none());
    let entries = view.search("anything", SearchOptions::default()).await.unwrap();
    assert_eq!(entries[0].content, "recalled");
    view.initialize().await.unwrap();
    assert_eq!(backing.initialized.load(Ordering::SeqCst), 1);
    let manager = resolve_memory(
        ResolveMemoryOptions {
            stores: vec![backing],
            read_only: true,
            ..Default::default()
        },
        &offline_env(),
    )
    .unwrap();
    assert!(tool_names(&manager).contains(&"search_memory".to_owned()));
}

#[test]
fn manages_consumer_supplied_stores_instead_of_the_default_file_store() {
    let backing: Arc<dyn MemoryStore> = Arc::new(Backing {
        initialized: AtomicUsize::new(0),
    });
    let manager = resolve_memory(
        ResolveMemoryOptions {
            stores: vec![backing],
            ..Default::default()
        },
        &offline_env(),
    )
    .unwrap();
    assert!(tool_names(&manager).contains(&"search_memory".to_owned()));
}

#[tokio::test]
async fn falls_back_to_the_default_file_store_when_stores_is_an_empty_array() {
    let dir = tempfile::tempdir().unwrap();
    let options = ResolveMemoryOptions {
        model: Some(mock("test-model").into()),
        dir: Some(dir.path().to_path_buf()),
        stores: Vec::new(),
        ..Default::default()
    };
    let (store, model) = default_store(&options, &offline_env()).unwrap();
    assert_eq!(store.name(), "memory");
    assert_eq!(model.unwrap().model_id().as_deref(), Some("test-model"));
    let names = tool_names(&resolve_memory(options, &offline_env()).unwrap());
    assert!(names.contains(&"search_memory".to_owned()));
}
