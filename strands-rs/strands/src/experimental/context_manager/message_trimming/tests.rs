use std::sync::Arc;

use super::*;
use crate::experimental::context_manager::test_support::{TestModel, agent_with, assistant, texts_of, user};
use crate::storage::InMemoryStorage;

fn format_test(tokens: u64) -> String {
    format!("[removed: {tokens}]")
}

#[tokio::test]
async fn leaves_one_placeholder_per_run_each_with_its_own_reference() {
    let mut agent = agent_with(
        Arc::new(TestModel::new()),
        vec![
            user("task"),
            assistant("a1"),
            user("q2"),
            assistant("a2"),
            user("q3"),
            assistant("a3"),
        ],
    );
    let stash = Stash::new(Arc::new(InMemoryStorage::new()), "session", "agent").unwrap();
    let text = FormattedPlaceholder::new(format_test);
    assert!(
        remove_messages(&mut agent, &[1, 3], &text, OffloadMethod::Drop, Some(&stash))
            .await
            .unwrap()
    );
    let references: Vec<Option<String>> = agent
        .messages()
        .iter()
        .flat_map(|message| &message.content)
        .filter_map(|block| match block {
            ContentBlock::Text(text) => text.offloaded.as_ref().map(|offloaded| offloaded.reference.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(references.len(), 2);
    assert!(references.iter().all(Option::is_some));
    assert_eq!(stash.list("").await.unwrap().len(), 2);
}

#[tokio::test]
async fn keeps_a_run_whose_placeholder_is_none() {
    struct Keep;

    #[async_trait]
    impl PlaceholderText for Keep {
        async fn text_for(&self, _agent: &LocalAgent, _removed: &[Message]) -> Result<Option<Placeholder>> {
            Ok(None)
        }
    }

    let messages = vec![user("task"), assistant("a1"), user("q2"), assistant("a2")];
    let mut agent = agent_with(Arc::new(TestModel::new()), messages.clone());
    assert!(
        !remove_messages(&mut agent, &[1], &Keep, OffloadMethod::Summarize, None)
            .await
            .unwrap()
    );
    assert_eq!(texts_of(agent.messages()), texts_of(&messages));
}

#[test]
fn splits_sorted_indices_into_adjacent_runs() {
    assert_eq!(split_into_runs(&[1, 2, 4, 6, 7, 8]), [1..3, 4..5, 6..9]);
    assert!(split_into_runs(&[]).is_empty());
}

/// A storage whose writes never finish, so a pass dropped mid-write leaves what it had done.
#[derive(Default)]
struct StalledWrites {
    inner: crate::storage::InMemoryStorage,
}

#[async_trait]
impl crate::storage::Storage for StalledWrites {
    async fn write(&self, _key: &str, _data: &[u8]) -> Result<()> {
        std::future::pending().await
    }

    async fn read(&self, key: &str) -> Result<Option<Vec<u8>>> {
        self.inner.read(key).await
    }

    async fn delete(&self, key: &str) -> Result<()> {
        self.inner.delete(key).await
    }

    async fn list(&self, prefix: &str) -> Result<Vec<String>> {
        self.inner.list(prefix).await
    }
}

#[tokio::test]
async fn keeps_a_run_in_the_history_when_the_pass_is_dropped_while_it_is_stashed() {
    let messages = vec![user("task"), assistant("a1"), user("q2"), assistant("a2")];
    let mut agent = agent_with(Arc::new(TestModel::new()), messages.clone());
    let stash = Stash::new(Arc::new(StalledWrites::default()), "session", "agent").unwrap();
    let text = FormattedPlaceholder::new(format_test);
    let removal = remove_messages(&mut agent, &[1], &text, OffloadMethod::Drop, Some(&stash));
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(20), removal)
            .await
            .is_err()
    );
    assert_eq!(texts_of(agent.messages()), texts_of(&messages));
}
