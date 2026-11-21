//! Compile-and-run checks of the public surface: builder names, builder conversions and the
//! testing constructors.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test helpers report failures by panicking"
)]

use std::sync::Arc;

use strands::context_manager::{ContextManager, ContextManagerConfig, ContextManagerConfigBuilder};
use strands::memory::{MemoryManagerConfigBuilder, SearchOptions};
use strands::storage::{InMemoryStorage, LocalFileStorageConfigBuilder, Storage};
use strands::testing::MockModel;
use strands::vended_memory_stores::file_memory_store::{FileMemoryStore, FileMemoryStoreConfig};
use strands::vended_memory_stores::test_memory_store::TestMemoryStoreConfig;
use strands::vended_plugins::skills::{AgentSkillsConfigBuilder, SkillLoadOptions};
use strands::{Agent, MemoryStore};

#[test]
fn builder_types_are_nameable_next_to_their_configs() {
    let _: ContextManagerConfigBuilder = ContextManagerConfig::builder();
    let _: MemoryManagerConfigBuilder = strands::memory::MemoryManagerConfig::builder();
    let _: LocalFileStorageConfigBuilder = strands::storage::LocalFileStorageConfig::builder();
    let _: AgentSkillsConfigBuilder = strands::vended_plugins::skills::AgentSkillsConfig::builder();
}

#[test]
fn the_agent_builder_takes_a_context_manager_config_or_instance_directly() {
    Agent::builder()
        .model(MockModel::new())
        .context_manager(ContextManagerConfig::default())
        .printer(false)
        .build()
        .unwrap();
    let manager = ContextManager::new(ContextManagerConfig::default()).unwrap();
    let agent = Agent::builder()
        .model(MockModel::new())
        .context_manager(manager.clone())
        .printer(false)
        .build()
        .unwrap();
    assert_eq!(agent.context_manager().unwrap(), &manager);
    let shared = Arc::new(manager.clone());
    let agent = Agent::builder()
        .model(MockModel::new())
        .context_manager(shared)
        .printer(false)
        .build()
        .unwrap();
    assert_eq!(agent.context_manager().unwrap(), &manager);
    assert_ne!(
        agent.context_manager().unwrap(),
        &ContextManager::new(ContextManagerConfig::default()).unwrap()
    );
}

#[tokio::test]
async fn store_configs_build_with_the_name_first() {
    let config = FileMemoryStoreConfig::builder("notes")
        .description("Things to remember")
        .storage(Arc::new(InMemoryStorage::new()) as Arc<dyn Storage>)
        .build();
    let store = FileMemoryStore::new(config).unwrap();
    assert_eq!(store.name(), "notes");
    store.add("# Prefs\nLikes tea", None).await.unwrap();
    assert_eq!(store.search("tea", SearchOptions::default()).await.unwrap().len(), 1);

    let config = TestMemoryStoreConfig::builder("scratch").persist(false).build();
    assert_eq!(config.name, "scratch");
    assert_eq!(config.persist, Some(false));
}

#[test]
fn skill_load_options_build_lenient_by_default() {
    assert_eq!(SkillLoadOptions::builder().build(), SkillLoadOptions::default());
    assert_eq!(
        SkillLoadOptions::builder().strict(true).build(),
        SkillLoadOptions::strict()
    );
}
