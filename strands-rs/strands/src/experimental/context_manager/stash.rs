//! The L1 stash: durable storage for content the context manager offloads, so the agent can
//! retrieve it with `retrieve_context`.

use std::collections::HashSet;
use std::fmt;
use std::sync::Arc;

use super::placeholder::{is_offloaded, is_offloaded_content};
use super::strategies::offload::target::is_protocol_block;
use crate::error::Result;
use crate::storage::{NamespacedStorage, Storage};
use crate::types::{ContentBlock, JsonObject, JsonValue, Message, ToolResultBlock};

/// The key prefix every per-agent stash lives under (`STASH_PREFIX`).
pub(crate) const STASH_PREFIX: &str = "context";

/// A stash key, `<id>_<index>` (`StashKey`). The id is a tool result's `toolUseId`, a message's
/// `trackingId`, or `removed-<trackingId>` for messages removed together.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StashKey {
    /// Owner of the entry.
    pub(crate) id: String,
    /// Position of the entry among the owner's items.
    pub(crate) index: usize,
}

/// `<id>_<index>` (`formatStashKey`).
pub(crate) fn format_stash_key(id: &str, index: usize) -> String {
    format!("{id}_{index}")
}

/// Parses a stash key (`parseStashKey`). The id may itself contain `_`, so the index is whatever
/// follows the last one; `None` when that is not an index.
pub(crate) fn parse_stash_key(key: &str) -> Option<StashKey> {
    let separator = key.rfind('_').filter(|&separator| separator > 0)?;
    let index = &key[separator + 1..];
    if index.is_empty() || !index.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(StashKey {
        id: key[..separator].to_owned(),
        index: index.parse().ok()?,
    })
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
        let key = format_stash_key(id, block_index);
        self.inner.storage.write(&key, data).await?;
        Ok(key)
    }

    /// The reference an offload placeholder carries for the block it replaces, with the block
    /// stored under that reference if it is not already (`ensureStashed`).
    ///
    /// A tool result is referenced by its `toolUseId`; the retrieval tool resolves it to every
    /// stored item (`<toolUseId>_<i>`). Any other block is referenced by its position
    /// (`<trackingId>_<blockIndex>`). History edits move blocks between messages and positions, so
    /// the key a block was stored under on arrival can differ from its key now; storing here keeps
    /// every emitted reference resolvable.
    ///
    /// # Errors
    ///
    /// The storage's list or write error.
    pub(crate) async fn ensure_stashed(
        &self,
        block: &ContentBlock,
        message: &Message,
        block_index: usize,
    ) -> Result<String> {
        if let ContentBlock::ToolResult(result) = block {
            // A result that already holds a placeholder is not the original; its items were stored
            // before it was offloaded.
            if result.content.iter().any(is_offloaded_content) {
                return Ok(result.tool_use_id.clone());
            }
            if self.keys_of(&result.tool_use_id).await?.len() < result.content.len() {
                self.store_tool_result(result).await;
            }
            return Ok(result.tool_use_id.clone());
        }
        let key = format_stash_key(message.tracking_id(), block_index);
        if !self.list(&key).await?.contains(&key) {
            self.store(message.tracking_id(), block_index, &encode(block)?).await?;
        }
        Ok(key)
    }

    /// Stores messages removed from the context window as one entry and returns the reference the
    /// placeholder left in their place carries (`storeRemoved`).
    ///
    /// # Errors
    ///
    /// The storage's write error.
    pub(crate) async fn store_removed(&self, removed: &[Message]) -> Result<String> {
        let first = removed.first().map_or("", Message::tracking_id);
        let id = format!("removed-{first}");
        self.store(&id, 0, &encode(&removed)?).await?;
        Ok(id)
    }

    /// Stores every block of a message as it arrives (`storeMessage`). Protocol blocks, offload
    /// placeholders and tool results in `skip_tool_use_ids` are left out, and a block already
    /// stored under one of `stored_keys` keeps its entry, since a restored history can hold a
    /// placeholder where the stored original was. Failures are logged.
    pub async fn store_message(
        &self,
        message: &Message,
        skip_tool_use_ids: Option<&HashSet<String>>,
        stored_keys: Option<&HashSet<String>>,
    ) {
        for (block_index, block) in message.content.iter().enumerate() {
            if is_skipped(block, message, block_index, skip_tool_use_ids, stored_keys) {
                continue;
            }
            if let ContentBlock::ToolResult(result) = block {
                self.store_tool_result(result).await;
                continue;
            }
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

    /// The stored references starting with `prefix`; every one for `""` (`list`).
    ///
    /// # Errors
    ///
    /// The storage's list error.
    pub async fn list(&self, prefix: &str) -> Result<Vec<String>> {
        self.inner.storage.list(prefix).await
    }

    /// The keys stored under `id`, in index order (`keysOf`). A prefix list alone also returns ids
    /// that extend this one.
    ///
    /// # Errors
    ///
    /// The storage's list error.
    pub(crate) async fn keys_of(&self, id: &str) -> Result<Vec<String>> {
        let mut keys: Vec<(usize, String)> = self
            .list(&format!("{id}_"))
            .await?
            .into_iter()
            .filter_map(|key| {
                let parsed = parse_stash_key(&key)?;
                (parsed.id == id).then_some((parsed.index, key))
            })
            .collect();
        keys.sort_by_key(|(index, _)| *index);
        Ok(keys.into_iter().map(|(_, key)| key).collect())
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
        for key in self.list("").await? {
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
        for key in self.list("").await? {
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

/// Whether [`Stash::store_message`] leaves a block out.
fn is_skipped(
    block: &ContentBlock,
    message: &Message,
    block_index: usize,
    skip_tool_use_ids: Option<&HashSet<String>>,
    stored_keys: Option<&HashSet<String>>,
) -> bool {
    if is_protocol_block(block) {
        return true;
    }
    if let ContentBlock::ToolResult(result) = block {
        if skip_tool_use_ids.is_some_and(|skip| skip.contains(&result.tool_use_id))
            || result.content.iter().any(is_offloaded_content)
        {
            return true;
        }
        return stored_keys.is_some_and(|keys| {
            keys.iter()
                .any(|key| parse_stash_key(key).is_some_and(|parsed| parsed.id == result.tool_use_id))
        });
    }
    if is_offloaded(block) {
        return true;
    }
    stored_keys.is_some_and(|keys| keys.contains(&format_stash_key(message.tracking_id(), block_index)))
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
