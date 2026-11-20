//! Keyword search by token overlap.

use std::collections::HashSet;
use std::sync::LazyLock;

use async_trait::async_trait;
use futures::future::join_all;
use regex::Regex;

use super::{SearchStrategy, StorageSearchResult};
use crate::error::Result;
use crate::storage::Storage;

/// Entries read concurrently per batch, to avoid throttling remote backends.
const READ_BATCH_SIZE: usize = 8;

static NON_WORD: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"[^\p{L}\p{N}_]+").ok());

/// Query words that carry no retrieval signal (`STOP_WORDS`).
pub(crate) static STOP_WORDS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    [
        "a", "an", "the", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "do", "does", "did",
        "will", "would", "could", "should", "may", "might", "shall", "can", "need", "dare", "ought", "used", "to",
        "of", "in", "for", "on", "with", "at", "by", "from", "as", "into", "through", "during", "before", "after",
        "above", "below", "between", "out", "off", "over", "under", "again", "further", "then", "once", "and", "but",
        "or", "nor", "not", "so", "yet", "both", "either", "neither", "each", "every", "all", "any", "few", "more",
        "most", "other", "some", "such", "no", "only", "own", "same", "than", "too", "very", "just", "because",
        "about", "up", "its", "it", "he", "she", "they", "we", "you", "i", "me", "him", "her", "us", "them", "my",
        "your", "his", "our", "their", "this", "that", "these", "those", "what", "which", "who", "whom", "when",
        "where", "why", "how", "if", "while", "although", "though", "unless", "until", "since",
    ]
    .into_iter()
    .collect()
});

/// Splits text into its distinct lowercased word tokens (`tokenize`): runs of Unicode letters,
/// numbers and `_`.
pub(crate) fn tokenize(text: &str) -> HashSet<String> {
    let lower = text.to_lowercase();
    match NON_WORD.as_ref() {
        Some(non_word) => non_word
            .split(&lower)
            .filter(|token| !token.is_empty())
            .map(str::to_owned)
            .collect(),
        None => lower
            .split(|c: char| !(c.is_alphanumeric() || c == '_'))
            .filter(|token| !token.is_empty())
            .map(str::to_owned)
            .collect(),
    }
}

/// How many distinct tokens of `content` appear in `query_tokens`.
pub(crate) fn token_overlap_score(query_tokens: &HashSet<String>, content: &str) -> usize {
    tokenize(content)
        .iter()
        .filter(|token| query_tokens.contains(*token))
        .count()
}

/// Strips a key's file extension so it is not scored as a word (`md` on every `.md` entry): the
/// last `.ext` of the last segment, when the dot follows another character of that segment.
fn strip_extension(key: &str) -> &str {
    let Some(dot) = key.rfind('.') else {
        return key;
    };
    let follows_segment_char = key[..dot].chars().next_back().is_some_and(|c| c != '/');
    if key[dot..].contains('/') || !follows_segment_char {
        return key;
    }
    &key[..dot]
}

/// Keyword search by token overlap (`KeywordSearchStrategy`), the default for every shipped
/// backend.
///
/// Tokenizes the query and each entry (the key without its file extension, then the content) and
/// scores by the number of distinct query tokens the entry contains. Stop words in the query
/// (`the`, `is`, `what`, ...) are ignored. Works on any backend through `list` and `read`, with no
/// index. Entries are read in concurrent batches of 8, each result carries the bytes read, and
/// entries whose read fails are skipped and logged at debug level.
///
/// ```
/// use strands::storage::search::{KeywordSearchStrategy, SearchStrategy};
/// use strands::storage::{InMemoryStorage, Storage};
///
/// # #[tokio::main(flavor = "current_thread")]
/// # async fn main() -> strands::Result<()> {
/// let storage = InMemoryStorage::new();
/// storage.write("notes/theme.md", b"enable dark mode").await?;
/// let results = KeywordSearchStrategy::new().search(&storage, "dark mode toggle").await?;
/// assert_eq!((results[0].key.as_str(), results[0].score), ("notes/theme.md", 2.0));
/// # Ok(())
/// # }
/// ```
#[derive(Debug, Clone, Copy, Default)]
#[non_exhaustive]
pub struct KeywordSearchStrategy;

impl KeywordSearchStrategy {
    /// Creates the strategy.
    #[must_use]
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl SearchStrategy for KeywordSearchStrategy {
    async fn search(&self, storage: &dyn Storage, query: &str) -> Result<Vec<StorageSearchResult>> {
        let query_tokens: HashSet<String> = tokenize(query)
            .into_iter()
            .filter(|token| !STOP_WORDS.contains(token.as_str()))
            .collect();
        if query_tokens.is_empty() {
            return Ok(Vec::new());
        }

        let keys = storage.list("").await?;
        let mut scored = Vec::new();
        for batch in keys.chunks(READ_BATCH_SIZE) {
            let reads = join_all(batch.iter().map(|key| read_or_skip(storage, key))).await;
            for (key, bytes) in batch.iter().zip(reads) {
                let Some(bytes) = bytes else {
                    continue;
                };
                let text = format!("{} {}", strip_extension(key), String::from_utf8_lossy(&bytes));
                let score = token_overlap_score(&query_tokens, &text);
                if score > 0 {
                    scored.push(StorageSearchResult::new(key.clone(), score as f64).with_data(bytes));
                }
            }
        }
        scored.sort_by(|a, b| b.score.total_cmp(&a.score));
        Ok(scored)
    }
}

/// Reads `key`, or `None` when the read fails, so one unreadable entry cannot fail a search.
async fn read_or_skip(storage: &dyn Storage, key: &str) -> Option<Vec<u8>> {
    match storage.read(key).await {
        Ok(bytes) => bytes,
        Err(error) => {
            tracing::debug!("key=<{key}>, error=<{error}> | skipped unreadable entry");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::error::StorageError;
    use crate::storage::InMemoryStorage;

    async fn storage_with(entries: &[(&str, &str)]) -> InMemoryStorage {
        let storage = InMemoryStorage::new();
        for (key, content) in entries {
            storage.write(key, content.as_bytes()).await.unwrap();
        }
        storage
    }

    async fn keys(storage: &dyn Storage, query: &str) -> Vec<String> {
        let results = KeywordSearchStrategy.search(storage, query).await.unwrap();
        results.into_iter().map(|result| result.key).collect()
    }

    #[tokio::test]
    async fn returns_matching_entries_scored_by_token_overlap() {
        let storage = storage_with(&[
            ("notes/dark-mode.md", "enable dark mode in settings"),
            ("notes/deploy.md", "deploy to production"),
        ])
        .await;
        let results = KeywordSearchStrategy::new()
            .search(&storage, "dark mode")
            .await
            .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].key, "notes/dark-mode.md");
        assert!(results[0].score > 0.0);
    }

    #[tokio::test]
    async fn returns_the_stored_bytes_with_each_result() {
        let storage = storage_with(&[("notes/dark-mode.md", "enable dark mode in settings")]).await;
        let results = KeywordSearchStrategy::new()
            .search(&storage, "dark mode")
            .await
            .unwrap();
        assert_eq!(
            results,
            [StorageSearchResult::new("notes/dark-mode.md", 2.0).with_data(b"enable dark mode in settings".to_vec())]
        );
    }

    #[tokio::test]
    async fn skips_entries_whose_read_throws() {
        let storage = Instrumented::new(storage_with(&[("good.md", "dark mode"), ("locked.md", "dark mode")]).await);
        assert_eq!(keys(&storage, "dark mode").await, ["good.md"]);
    }

    #[tokio::test]
    async fn returns_empty_array_for_empty_query() {
        let storage = storage_with(&[("key", "content")]).await;
        assert!(keys(&storage, "").await.is_empty());
    }

    #[tokio::test]
    async fn returns_empty_array_for_whitespace_only_query() {
        let storage = storage_with(&[("key", "content")]).await;
        assert!(keys(&storage, "   ").await.is_empty());
    }

    #[tokio::test]
    async fn matches_case_insensitively() {
        let storage = storage_with(&[("note.md", "Dark Mode Toggle")]).await;
        assert_eq!(keys(&storage, "dark mode").await.len(), 1);
    }

    #[tokio::test]
    async fn includes_the_key_in_the_scoring_text() {
        let storage = storage_with(&[("dark-mode.md", "some unrelated body")]).await;
        assert_eq!(keys(&storage, "dark mode").await, ["dark-mode.md"]);
    }

    #[tokio::test]
    async fn ranks_results_by_score_descending() {
        let storage = storage_with(&[("a.md", "dark"), ("b.md", "dark mode toggle feature")]).await;
        let results = KeywordSearchStrategy::new()
            .search(&storage, "dark mode")
            .await
            .unwrap();
        assert_eq!(results.len(), 2);
        assert!(results[0].score >= results[1].score);
        assert_eq!(results[0].key, "b.md");
    }

    #[tokio::test]
    async fn returns_empty_array_when_no_content_matches() {
        let storage = storage_with(&[("note.md", "completely unrelated content")]).await;
        assert!(keys(&storage, "kubernetes deployment").await.is_empty());
    }

    #[tokio::test]
    async fn ignores_stop_words_in_the_query() {
        let storage = storage_with(&[
            ("deploy.md", "the deploy process runs nightly"),
            ("weather.md", "what is the weather like"),
        ])
        .await;
        assert_eq!(keys(&storage, "what is the deploy process").await, ["deploy.md"]);
    }

    #[tokio::test]
    async fn returns_empty_array_for_a_query_made_only_of_stop_words() {
        let storage = storage_with(&[("note.md", "what is the plan")]).await;
        assert!(keys(&storage, "what is the").await.is_empty());
    }

    #[tokio::test]
    async fn does_not_score_the_file_extension_of_the_key() {
        let storage = storage_with(&[("release-notes.md", "ship on fridays")]).await;
        assert!(keys(&storage, "update AGENTS.md").await.is_empty());
        assert_eq!(keys(&storage, "release").await, ["release-notes.md"]);
    }

    #[tokio::test]
    async fn reads_entries_in_concurrent_batches_of_at_most_8() {
        let inner = InMemoryStorage::new();
        for index in 0..20 {
            inner.write(&format!("note-{index}.md"), b"dark mode").await.unwrap();
        }
        let storage = Instrumented::new(inner);
        let results = KeywordSearchStrategy::new()
            .search(&storage, "dark mode")
            .await
            .unwrap();
        assert_eq!(results.len(), 20);
        assert_eq!(storage.max_in_flight.load(Ordering::SeqCst), 8);
    }

    #[test]
    fn tokenizes_unicode_letters_numbers_and_underscores() {
        let tokens = tokenize("Hello, world_1! café ΣΑΣ x²");
        let mut tokens: Vec<_> = tokens.into_iter().collect();
        tokens.sort();
        assert_eq!(tokens, ["café", "hello", "world_1", "x²", "σας"]);
    }

    #[test]
    fn strips_only_a_final_extension_that_follows_a_segment_character() {
        assert_eq!(strip_extension("notes/a.md"), "notes/a");
        assert_eq!(strip_extension("a.b.c"), "a.b");
        assert_eq!(strip_extension("a."), "a");
        assert_eq!(strip_extension(".env"), ".env");
        assert_eq!(strip_extension("notes/.hidden"), "notes/.hidden");
        assert_eq!(strip_extension("dir.x/file"), "dir.x/file");
        assert_eq!(strip_extension("plain"), "plain");
    }

    #[test]
    fn scores_distinct_overlapping_tokens() {
        let query = tokenize("dark mode");
        assert_eq!(token_overlap_score(&query, "dark dark mode light"), 2);
        assert_eq!(token_overlap_score(&query, "light"), 0);
    }

    /// Counts concurrent reads (each yields once) and fails reads of `locked.md`.
    struct Instrumented {
        inner: InMemoryStorage,
        in_flight: Arc<AtomicUsize>,
        max_in_flight: Arc<AtomicUsize>,
    }

    impl Instrumented {
        fn new(inner: InMemoryStorage) -> Self {
            Self {
                inner,
                in_flight: Arc::default(),
                max_in_flight: Arc::default(),
            }
        }
    }

    #[async_trait]
    impl Storage for Instrumented {
        async fn write(&self, key: &str, data: &[u8]) -> Result<()> {
            Storage::write(&self.inner, key, data).await
        }

        async fn read(&self, key: &str) -> Result<Option<Vec<u8>>> {
            if key == "locked.md" {
                return Err(StorageError::new("Failed to read 'locked.md' from local storage").into());
            }
            let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_in_flight.fetch_max(now, Ordering::SeqCst);
            tokio::task::yield_now().await;
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
            Storage::read(&self.inner, key).await
        }

        async fn delete(&self, key: &str) -> Result<()> {
            Storage::delete(&self.inner, key).await
        }

        async fn list(&self, prefix: &str) -> Result<Vec<String>> {
            Storage::list(&self.inner, prefix).await
        }
    }
}
