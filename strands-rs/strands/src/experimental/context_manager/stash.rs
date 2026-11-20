//! The L1 stash: durable storage for content the context manager offloads, so the agent can
//! retrieve it with `retrieve_context`.

use std::collections::HashSet;
use std::fmt;
use std::sync::{Arc, LazyLock};

use regex::Regex;

use crate::error::Result;
use crate::storage::{NamespacedStorage, Storage};
use crate::types::{ContentBlock, JsonObject, JsonValue, Message, ToolResultBlock, ToolResultContent};

/// The key prefix every per-agent stash lives under (`STASH_PREFIX`).
pub(crate) const STASH_PREFIX: &str = "context";

static STASH_REFS_SUFFIX: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r" \[refs?: [^\]]+\]$").ok());

fn ends_with_stash_refs(text: &str) -> bool {
    STASH_REFS_SUFFIX.as_ref().is_some_and(|pattern| pattern.is_match(text))
}

/// Whether serialized block data has a `text` ending with a [`format_stash_refs`] token, marking it
/// as an offload replacement.
pub(crate) fn is_offload_placeholder_data(data: &JsonValue) -> bool {
    data.get("text")
        .and_then(JsonValue::as_str)
        .is_some_and(ends_with_stash_refs)
}

/// The text a block carries, if any.
fn block_text(block: &ContentBlock) -> Option<&str> {
    match block {
        ContentBlock::Text(text) => Some(&text.text),
        ContentBlock::Reasoning(reasoning) => reasoning.text.as_deref(),
        ContentBlock::Summary(summary) => Some(&summary.text),
        ContentBlock::Injected(injected) => Some(&injected.text),
        _ => None,
    }
}

/// Whether a block's text ends with a [`format_stash_refs`] token.
pub(crate) fn is_offload_placeholder(block: &ContentBlock) -> bool {
    block_text(block).is_some_and(ends_with_stash_refs)
}

/// Whether tool result content is an offload replacement.
pub(crate) fn is_offload_placeholder_content(content: &ToolResultContent) -> bool {
    matches!(content, ToolResultContent::Text(text) if ends_with_stash_refs(&text.text))
}

/// Formats stash refs for placeholders: ` [ref: a]`, ` [refs: a, b]`, or empty.
pub(crate) fn format_stash_refs(refs: &[String]) -> String {
    match refs {
        [] => String::new(),
        [single] => format!(" [ref: {single}]"),
        refs => format!(" [refs: {}]", refs.join(", ")),
    }
}

fn encode(value: &impl serde::Serialize) -> Result<Vec<u8>> {
    Ok(serde_json::to_vec(value)?)
}

fn decode(bytes: &[u8]) -> Result<JsonValue> {
    Ok(serde_json::from_slice(bytes)?)
}

struct Inner {
    storage: Arc<dyn Storage>,
    base_storage: Arc<dyn Storage>,
    caller_scoped: bool,
    session_id: String,
    storage_type_name: String,
}

/// Key management and content framing over a [`Storage`] for the context manager's offloaded
/// content (`Stash`).
///
/// Each agent stashes under `context/<sessionId>/scopes/agent/<agentId>/`. Keys are deterministic
/// (`<toolUseId>_<index>` for tool result content, `<trackingId>_<blockIndex>` for other blocks),
/// so placeholders can name them before the content is stored again after a restore. Clones share
/// the same stash.
#[derive(Clone)]
pub struct Stash {
    inner: Arc<Inner>,
}

impl Stash {
    /// A stash for `agent_id` in `session_id`, under `context/<sessionId>/scopes/agent/<agentId>/`
    /// of `storage`.
    ///
    /// # Errors
    ///
    /// An id that does not form a valid storage prefix.
    pub fn new(storage: Arc<dyn Storage>, session_id: &str, agent_id: &str) -> Result<Self> {
        Self::with_namespace(storage, session_id, agent_id, false)
    }

    /// As [`new`](Self::new); with `custom_stash_namespace`, a namespaced view of a built-in backend
    /// is used as the exact stash root.
    pub(crate) fn with_namespace(
        storage: Arc<dyn Storage>,
        session_id: &str,
        agent_id: &str,
        custom_stash_namespace: bool,
    ) -> Result<Self> {
        let caller_scoped = custom_stash_namespace && storage.is_namespaced();
        let scoped: Arc<dyn Storage> = if caller_scoped {
            storage.clone()
        } else {
            Arc::new(NamespacedStorage::new(
                storage.clone(),
                &format!("{STASH_PREFIX}/{session_id}/scopes/agent/{agent_id}"),
            )?)
        };
        let storage_type_name = storage.storage_type().to_owned();
        Ok(Self {
            inner: Arc::new(Inner {
                storage: scoped,
                base_storage: storage,
                caller_scoped,
                session_id: session_id.to_owned(),
                storage_type_name,
            }),
        })
    }

    /// The type name of the base storage, recorded in session snapshots of a durable stash.
    #[must_use]
    pub fn storage_type_name(&self) -> &str {
        &self.inner.storage_type_name
    }

    /// Stores serialized data under `<id>_<blockIndex>` and returns that reference (`store`).
    ///
    /// # Errors
    ///
    /// The storage's write error.
    pub async fn store(&self, id: &str, block_index: usize, data: &[u8]) -> Result<String> {
        let key = format!("{id}_{block_index}");
        self.inner.storage.write(&key, data).await?;
        Ok(key)
    }

    /// The references a block's content is stored under: one per tool result item, or one for
    /// any other block.
    #[must_use]
    pub fn refs_for(&self, block: &ContentBlock, message: &Message, block_index: usize) -> Vec<String> {
        if let ContentBlock::ToolResult(result) = block {
            return (0..result.content.len())
                .map(|index| format!("{}_{index}", result.tool_use_id))
                .collect();
        }
        vec![format!("{}_{block_index}", message.tracking_id())]
    }

    /// Stores every block of a message as it arrives. Tool uses, cache points,
    /// reasoning, offload placeholders and tool results in `skip_tool_use_ids` are skipped;
    /// failures are logged.
    pub async fn store_message(&self, message: &Message, skip_tool_use_ids: Option<&HashSet<String>>) {
        for (block_index, block) in message.content.iter().enumerate() {
            match block {
                ContentBlock::ToolResult(result) => {
                    if skip_tool_use_ids.is_some_and(|skip| skip.contains(&result.tool_use_id)) {
                        continue;
                    }
                    if result.content.iter().any(is_offload_placeholder_content) {
                        continue;
                    }
                    self.store_tool_result(result).await;
                }
                ContentBlock::ToolUse(_) | ContentBlock::CachePoint(_) | ContentBlock::Reasoning(_) => {}
                block if is_offload_placeholder(block) => {}
                block => {
                    let stored = match encode(block) {
                        Ok(bytes) => self.store(message.tracking_id(), block_index, &bytes).await.map(drop),
                        Err(error) => Err(error),
                    };
                    if let Err(error) = stored {
                        tracing::warn!(
                            "tracking_id=<{}>, error=<{error}> | failed to stash block",
                            message.tracking_id()
                        );
                    }
                }
            }
        }
    }

    async fn store_tool_result(&self, block: &ToolResultBlock) {
        for (block_index, item) in block.content.iter().enumerate() {
            let stored = match encode(item) {
                Ok(bytes) => self.store(&block.tool_use_id, block_index, &bytes).await.map(drop),
                Err(error) => Err(error),
            };
            if let Err(error) = stored {
                tracing::warn!(
                    "tool_use_id=<{}>, block_index=<{block_index}>, error=<{error}> | failed to stash sub-block",
                    block.tool_use_id
                );
            }
        }
    }

    /// The stored JSON of a reference, or `None` when there is none (`retrieve`).
    ///
    /// # Errors
    ///
    /// The storage's read error, or stored bytes that are not JSON.
    pub async fn retrieve(&self, reference: &str) -> Result<Option<JsonValue>> {
        let Some(bytes) = self.inner.storage.read(reference).await? else {
            return Ok(None);
        };
        decode(&bytes).map(Some)
    }

    /// Every stored reference (`list`).
    ///
    /// # Errors
    ///
    /// The storage's list error.
    pub async fn list(&self) -> Result<Vec<String>> {
        self.inner.storage.list("").await
    }

    /// Deletes a stored entry (`delete`).
    ///
    /// # Errors
    ///
    /// The storage's delete error.
    pub async fn delete(&self, reference: &str) -> Result<()> {
        self.inner.storage.delete(reference).await?;
        tracing::debug!("reference=<{reference}> | stash entry deleted");
        Ok(())
    }

    /// Deletes every entry of this stash (`clear`). On a caller-scoped stash this is the whole
    /// shared view, other agents' entries included.
    ///
    /// # Errors
    ///
    /// The storage's list or delete error.
    pub async fn clear(&self) -> Result<()> {
        for key in self.list().await? {
            self.delete(&key).await?;
        }
        Ok(())
    }

    /// Deletes the stash data of this session for every agent, `context/<sessionId>/` on the base
    /// storage. A caller-scoped stash may be shared beyond the session and is
    /// left in place.
    ///
    /// # Errors
    ///
    /// The storage's list or delete error.
    pub async fn clear_session(&self) -> Result<()> {
        if self.inner.caller_scoped {
            tracing::debug!(
                "session_id=<{}> | skipping stash deletion, stash is caller-scoped",
                self.inner.session_id
            );
            return Ok(());
        }
        let prefix = format!("{STASH_PREFIX}/{}/", self.inner.session_id);
        for key in self.inner.base_storage.list(&prefix).await? {
            self.inner.base_storage.delete(&key).await?;
        }
        Ok(())
    }

    /// Every entry as reference to stored JSON, for a session snapshot.
    ///
    /// # Errors
    ///
    /// The storage's errors, or stored bytes that are not JSON.
    pub async fn take_snapshot(&self) -> Result<JsonObject> {
        let mut entries = JsonObject::new();
        for key in self.list().await? {
            if let Some(data) = self.retrieve(&key).await? {
                entries.insert(key, data);
            }
        }
        Ok(entries)
    }

    /// Writes back entries captured by [`take_snapshot`](Self::take_snapshot).
    ///
    /// # Errors
    ///
    /// The storage's write error.
    pub async fn load_snapshot(&self, entries: &JsonObject) -> Result<()> {
        for (key, data) in entries {
            self.inner.storage.write(key, &encode(data)?).await?;
        }
        Ok(())
    }
}

impl fmt::Debug for Stash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Stash")
            .field("session_id", &self.inner.session_id)
            .field("storage_type_name", &self.inner.storage_type_name)
            .field("caller_scoped", &self.inner.caller_scoped)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
#[path = "stash/tests.rs"]
mod tests;
