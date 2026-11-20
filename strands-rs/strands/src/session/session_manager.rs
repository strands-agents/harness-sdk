//! The session manager: saves an agent's snapshots to a [`Storage`] and restores them when the
//! agent initializes.

use std::fmt;
use std::sync::{Arc, PoisonError, RwLock};

use async_trait::async_trait;

use super::clock::UuidV7Source;
use super::snapshot_storage_adapter::{SnapshotLocation, SnapshotStorageAdapter};
use super::types::{SnapshotTriggerCallback, SnapshotTriggerParams};
use super::validation::validate_identifier;
use crate::agent::{LocalAgent, TakeSnapshotOptions};
use crate::error::{Error, Result};
use crate::experimental::context_manager::{AgentStash, Stash};
use crate::hooks::{AfterInvocationEvent, AfterModelCallEvent, InitializedEvent, MessageAddedEvent};
use crate::plugins::Plugin;
use crate::storage::{NamespacedStorage, Storage};
use crate::types::{JsonObject, JsonValue, Scope, Snapshot};

const SESSION_MANAGER_NAME: &str = "strands:session-manager";
const DEFAULT_SESSION_ID: &str = "default-session";
const SESSION_NAMESPACE: &str = "session";
const LATEST_SNAPSHOT_ID: &str = "latest";
const NO_STORAGE_ERROR: &str =
    "SessionManager requires a storage backend. Provide storage in SessionManagerConfig or set storage on the Agent.";

/// When `snapshot_latest` is saved automatically (`SaveLatestStrategy`).
///
/// A session keeps one mutable `snapshot_latest`, overwritten on each save to resume the most
/// recent state, and append-only immutable snapshots (UUID v7 ids), written only when the
/// [`snapshot_trigger`](SessionManagerConfig::snapshot_trigger) fires.
///
/// Under [`Invocation`](Self::Invocation) and [`Message`](Self::Message) a guardrail redaction is
/// saved at once, so pre-redaction content never sits at rest. Under [`Trigger`](Self::Trigger)
/// the trigger stays in control.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum SaveLatestStrategy {
    /// After every added message and when an invocation completes (`'message'`): most durable,
    /// most I/O.
    Message,
    /// After every invocation (`'invocation'`, the default).
    #[default]
    Invocation,
    /// Only when the snapshot trigger fires, or through
    /// [`SessionManager::save_snapshot`] (`'trigger'`).
    Trigger,
}

/// Configuration for a [`SessionManager`] (`SessionManagerConfig`).
#[derive(Default, bon::Builder)]
#[builder(
    builder_type(name = SessionManagerBuilder, vis = "pub", doc {
        /// Builds a [`SessionManager`]; the setters are the [`SessionManagerConfig`] keys.
    }),
    start_fn(name = builder, vis = "pub(crate)"),
    finish_fn(name = into_config, vis = "pub(crate)")
)]
pub struct SessionManagerConfig {
    /// Storage for the snapshots. A storage that is not namespaced is scoped under `session`.
    /// Unset, the session manager uses the agent's
    /// [`storage`](crate::AgentConfig::storage) when it attaches; without either it fails. The
    /// builder's `storage(..)` takes a storage by value or as an `Arc`.
    #[builder(with = |storage: impl crate::storage::IntoStorage| storage.into_storage())]
    pub storage: Option<Arc<dyn Storage>>,
    /// The session id; `^[a-z0-9_-]+$`. Defaults to `default-session`.
    #[builder(into)]
    pub session_id: Option<String>,
    /// When to save `snapshot_latest`. Defaults to [`SaveLatestStrategy::Invocation`].
    pub save_latest_on: Option<SaveLatestStrategy>,
    /// Decides after each invocation whether to also save an immutable snapshot. The builder
    /// takes a [`SnapshotTriggerCallback`] or a closure with annotated arguments.
    #[builder(into)]
    pub snapshot_trigger: Option<SnapshotTriggerCallback>,
}

impl<S: session_manager_builder::IsComplete> SessionManagerBuilder<S> {
    /// Builds the session manager.
    ///
    /// # Errors
    ///
    /// The same errors as [`SessionManager::new`].
    pub fn build(self) -> Result<SessionManager> {
        SessionManager::new(self.into_config())
    }
}

impl fmt::Debug for SessionManagerConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SessionManagerConfig")
            .field("storage", &self.storage.as_ref().map(|storage| storage.storage_type()))
            .field("session_id", &self.session_id)
            .field("save_latest_on", &self.save_latest_on)
            .field("snapshot_trigger", &self.snapshot_trigger.is_some())
            .finish()
    }
}

/// Saves and restores an agent's session (`SessionManager`).
///
/// Attached to an agent through [`AgentConfig::session_manager`](crate::AgentConfig::session_manager),
/// it restores `snapshot_latest` (messages, state, system prompt, model state and interrupt
/// state) when the agent initializes, and saves it as [`SaveLatestStrategy`] says. Snapshots live
/// under `<sessionId>/scopes/agent/<agentId>/snapshots/` in the storage, the layout shared with the
/// other Strands SDKs, so agents in any of them can share a session.
///
/// Clones share one manager: keep a clone to call [`save_snapshot`](Self::save_snapshot) or
/// [`delete_session`](Self::delete_session) after handing one to the agent.
///
/// ```
/// use std::sync::Arc;
///
/// use strands::storage::InMemoryStorage;
/// use strands::testing::MockModel;
/// use strands::{Agent, SessionManager};
///
/// # #[tokio::main(flavor = "current_thread")]
/// # async fn main() -> strands::Result<()> {
/// let storage = Arc::new(InMemoryStorage::new());
/// let session = SessionManager::builder()
///     .session_id("my-session")
///     .storage(storage.clone())
///     .build()?;
/// let mut agent = Agent::builder()
///     .model(MockModel::new().with_turn("Hello!"))
///     .session_manager(session)
///     .printer(false)
///     .build()?;
/// agent.invoke("Hi").await?;
///
/// let mut restored = Agent::builder()
///     .model(MockModel::new())
///     .session_manager(SessionManager::builder().session_id("my-session").storage(storage).build()?)
///     .printer(false)
///     .build()?;
/// restored.initialize().await?;
/// assert_eq!(restored.messages().len(), 2);
/// # Ok(())
/// # }
/// ```
#[derive(Clone)]
pub struct SessionManager {
    inner: Arc<Inner>,
}

struct Inner {
    session_id: String,
    has_config_storage: bool,
    storage: RwLock<Option<SnapshotStorageAdapter>>,
    save_latest_on: SaveLatestStrategy,
    snapshot_trigger: Option<SnapshotTriggerCallback>,
    ids: UuidV7Source,
    agent_stash: RwLock<Option<Stash>>,
}

impl SessionManager {
    /// Starts a session manager builder; its setters are the [`SessionManagerConfig`] keys.
    pub fn builder() -> SessionManagerBuilder {
        SessionManagerConfig::builder()
    }

    /// Creates a session manager (`new SessionManager(config)`).
    ///
    /// # Errors
    ///
    /// A session id that does not match `^[a-z0-9_-]+$`.
    pub fn new(config: SessionManagerConfig) -> Result<Self> {
        Self::with_id_source(config, UuidV7Source::system())
    }

    /// A session manager whose immutable snapshot ids come from `ids`.
    pub(crate) fn with_id_source(config: SessionManagerConfig, ids: UuidV7Source) -> Result<Self> {
        let session_id = config.session_id.unwrap_or_else(|| DEFAULT_SESSION_ID.to_owned());
        validate_identifier(&session_id)?;
        let has_config_storage = config.storage.is_some();
        let storage = config.storage.map(resolve_snapshot_storage).transpose()?;
        Ok(Self {
            inner: Arc::new(Inner {
                session_id,
                has_config_storage,
                storage: RwLock::new(storage),
                save_latest_on: config.save_latest_on.unwrap_or_default(),
                snapshot_trigger: config.snapshot_trigger,
                ids,
                agent_stash: RwLock::new(None),
            }),
        })
    }

    /// The session id.
    #[must_use]
    pub fn session_id(&self) -> &str {
        &self.inner.session_id
    }

    /// Saves the agent's `session` snapshot as `snapshot_latest`, or as a new immutable snapshot
    /// with a fresh UUID v7 id.
    ///
    /// # Errors
    ///
    /// No storage, an agent id that is not a valid identifier, or a failed write.
    pub async fn save_snapshot(&self, target: &LocalAgent, is_latest: bool) -> Result<()> {
        self.inner.save_snapshot(target, is_latest).await
    }

    /// Loads `snapshot_latest`, or the immutable snapshot `snapshot_id`, into the agent. Returns
    /// `false` when the snapshot does not exist.
    ///
    /// # Errors
    ///
    /// No storage, an invalid id, a failed read or a snapshot that does not load.
    pub async fn restore_snapshot(&self, target: &mut LocalAgent, snapshot_id: Option<&str>) -> Result<bool> {
        self.inner.restore_snapshot(target, snapshot_id).await
    }

    /// The agent's immutable snapshot ids, oldest first: at most `limit`, after the exclusive
    /// cursor `start_after`.
    ///
    /// # Errors
    ///
    /// No storage, an invalid cursor or a failed listing.
    pub async fn list_snapshot_ids(
        &self,
        target: &LocalAgent,
        limit: Option<usize>,
        start_after: Option<&str>,
    ) -> Result<Vec<String>> {
        let location = self.inner.location(target);
        self.inner
            .adapter()?
            .list_snapshot_ids(&location, limit, start_after)
            .await
    }

    /// Deletes every snapshot, manifest and stash entry of the session. A stash
    /// rooted at a caller-scoped view is shared beyond the session and is kept.
    ///
    /// # Errors
    ///
    /// No storage or a failed delete.
    pub async fn delete_session(&self) -> Result<()> {
        self.inner.adapter()?.delete_session(&self.inner.session_id).await?;
        let stash = self
            .inner
            .agent_stash
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        if let Some(stash) = stash {
            stash.clear_session().await?;
        }
        Ok(())
    }
}

impl Inner {
    fn adapter(&self) -> Result<SnapshotStorageAdapter> {
        self.storage
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
            .ok_or_else(|| Error::other(NO_STORAGE_ERROR))
    }

    fn location(&self, agent: &LocalAgent) -> SnapshotLocation {
        SnapshotLocation::new(&self.session_id, Scope::Agent, agent.id())
    }

    async fn save_snapshot(&self, agent: &LocalAgent, is_latest: bool) -> Result<()> {
        let mut snapshot = agent.take_snapshot(TakeSnapshotOptions::session())?;
        include_stash_data(agent, &mut snapshot).await?;
        let snapshot_id = if is_latest {
            LATEST_SNAPSHOT_ID.to_owned()
        } else {
            self.ids.next_id()
        };
        self.adapter()?
            .save_snapshot(&self.location(agent), &snapshot_id, is_latest, &snapshot)
            .await
    }

    async fn restore_snapshot(&self, agent: &mut LocalAgent, snapshot_id: Option<&str>) -> Result<bool> {
        let location = self.location(agent);
        let Some(snapshot) = self.adapter()?.load_snapshot(&location, snapshot_id).await? else {
            return Ok(false);
        };
        agent.load_snapshot(&snapshot)?;
        self.restore_stash_data(agent, &snapshot).await?;
        Ok(true)
    }

    async fn on_initialized(&self, agent: &mut LocalAgent) -> Result<()> {
        let had_messages = !agent.messages().is_empty();
        let restored = self.restore_snapshot(agent, None).await?;
        if restored && had_messages {
            tracing::warn!(
                "agent_id=<{}>, session_id=<{}> | agent had existing messages that were overwritten by session restore",
                agent.id(),
                self.session_id
            );
        }
        if restored && agent.model().stateful() && !agent.messages().is_empty() {
            tracing::debug!(
                "agent_id=<{}>, message_count=<{}> | discarding restored messages for stateful model",
                agent.id(),
                agent.messages().len()
            );
            agent.messages_mut().clear();
        }
        Ok(())
    }

    async fn on_after_invocation(&self, agent: &LocalAgent) -> Result<()> {
        if self.save_latest_on != SaveLatestStrategy::Trigger {
            self.save_snapshot(agent, true).await?;
        }
        let fired = self
            .snapshot_trigger
            .as_ref()
            .is_some_and(|trigger| trigger(&SnapshotTriggerParams::new(agent)));
        if fired {
            self.save_immutable_and_latest(agent).await?;
        }
        Ok(())
    }

    /// Captures one snapshot and writes it as immutable history and as `snapshot_latest`.
    async fn save_immutable_and_latest(&self, agent: &LocalAgent) -> Result<()> {
        let mut snapshot: Snapshot = agent.take_snapshot(TakeSnapshotOptions::session())?;
        include_stash_data(agent, &mut snapshot).await?;
        let adapter = self.adapter()?;
        let location = self.location(agent);
        let snapshot_id = self.ids.next_id();
        futures::try_join!(
            adapter.save_snapshot(&location, &snapshot_id, false, &snapshot),
            adapter.save_snapshot(&location, LATEST_SNAPSHOT_ID, true, &snapshot),
        )?;
        Ok(())
    }
}

impl Inner {
    /// Loads inline stash entries into the agent's stash; an external stash is left where it is,
    /// with a warning when its storage type changed.
    async fn restore_stash_data(&self, agent: &LocalAgent, snapshot: &Snapshot) -> Result<()> {
        let Some(data) = snapshot.data.get(STASH_KEY).filter(|data| is_truthy(data)) else {
            return Ok(());
        };
        let Some(stash) = agent.context_stash().map(|agent_stash| &agent_stash.stash) else {
            return Ok(());
        };
        match data.get("location").and_then(JsonValue::as_str) {
            Some("external") => {
                let snapshot_type = data.get("storageType").and_then(JsonValue::as_str).unwrap_or_default();
                let current_type = stash.storage_type_name();
                if !snapshot_type.is_empty() && !current_type.is_empty() && snapshot_type != current_type {
                    tracing::warn!(
                        "session_id=<{}>, snapshot_storage=<{snapshot_type}>, current_storage=<{current_type}> | stash storage type changed since snapshot was created, stash data may be inaccessible",
                        self.session_id
                    );
                }
                Ok(())
            }
            Some("inline") => {
                let entries = data
                    .get("entries")
                    .and_then(JsonValue::as_object)
                    .cloned()
                    .unwrap_or_default();
                stash.load_snapshot(&entries).await
            }
            _ => Ok(()),
        }
    }
}

const STASH_KEY: &str = "stash";

/// Whether a JSON value counts as stash data: `null`, `false`, `0` and `""` do not.
fn is_truthy(value: &JsonValue) -> bool {
    match value {
        JsonValue::Null => false,
        JsonValue::Bool(flag) => *flag,
        JsonValue::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        JsonValue::String(text) => !text.is_empty(),
        JsonValue::Array(_) | JsonValue::Object(_) => true,
    }
}

/// Adds the agent's stash to a snapshot: a reference to durable storage
/// (`{"location":"external","storageType":..}`), or the entries inline when there are any.
async fn include_stash_data(agent: &LocalAgent, snapshot: &mut Snapshot) -> Result<()> {
    let Some(AgentStash { stash, durable }) = agent.context_stash() else {
        return Ok(());
    };
    let mut envelope = JsonObject::new();
    if *durable {
        envelope.insert("location".to_owned(), JsonValue::from("external"));
        envelope.insert("storageType".to_owned(), JsonValue::from(stash.storage_type_name()));
        snapshot.data.insert(STASH_KEY.to_owned(), JsonValue::Object(envelope));
        return Ok(());
    }
    let entries = stash.take_snapshot().await?;
    if entries.is_empty() {
        return Ok(());
    }
    envelope.insert("location".to_owned(), JsonValue::from("inline"));
    envelope.insert("entries".to_owned(), JsonValue::Object(entries));
    snapshot.data.insert(STASH_KEY.to_owned(), JsonValue::Object(envelope));
    Ok(())
}

/// Scopes a storage that is not namespaced under `session`.
fn resolve_snapshot_storage(storage: Arc<dyn Storage>) -> Result<SnapshotStorageAdapter> {
    let scoped: Arc<dyn Storage> = if storage.is_namespaced() {
        storage
    } else {
        Arc::new(NamespacedStorage::new(storage, SESSION_NAMESPACE)?)
    };
    Ok(SnapshotStorageAdapter::new(scoped))
}

#[async_trait]
impl Plugin for SessionManager {
    fn name(&self) -> &str {
        SESSION_MANAGER_NAME
    }

    /// Resolves the storage from the agent when none was configured and registers the restore and
    /// save hooks.
    async fn init_agent(&self, agent: &mut LocalAgent) -> Result<()> {
        if !self.inner.has_config_storage {
            let storage = agent.storage().cloned().ok_or_else(|| Error::other(NO_STORAGE_ERROR))?;
            let adapter = resolve_snapshot_storage(storage)?;
            *self.inner.storage.write().unwrap_or_else(PoisonError::into_inner) = Some(adapter);
        }
        *self.inner.agent_stash.write().unwrap_or_else(PoisonError::into_inner) =
            agent.context_stash().map(|agent_stash| agent_stash.stash.clone());
        let inner = self.inner.clone();
        agent.add_async_hook::<InitializedEvent<'_>>(move |event| {
            let inner = inner.clone();
            Box::pin(async move { inner.on_initialized(event.agent_mut()).await })
        });
        if self.inner.save_latest_on == SaveLatestStrategy::Message {
            let inner = self.inner.clone();
            agent.add_async_hook::<MessageAddedEvent<'_>>(move |event| {
                let inner = inner.clone();
                Box::pin(async move { inner.save_snapshot(event.agent(), true).await })
            });
        }
        if self.inner.save_latest_on != SaveLatestStrategy::Trigger {
            let inner = self.inner.clone();
            agent.add_async_hook::<AfterModelCallEvent<'_>>(move |event| {
                let inner = inner.clone();
                Box::pin(async move {
                    let redacted = event.stop_data().is_some_and(|stop| stop.redaction.is_some());
                    if !redacted {
                        return Ok(());
                    }
                    inner.save_snapshot(event.agent(), true).await
                })
            });
        }
        let inner = self.inner.clone();
        agent.add_async_hook::<AfterInvocationEvent<'_>>(move |event| {
            let inner = inner.clone();
            Box::pin(async move { inner.on_after_invocation(event.agent()).await })
        });
        Ok(())
    }
}

impl fmt::Debug for SessionManager {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SessionManager")
            .field("session_id", &self.inner.session_id)
            .field("save_latest_on", &self.inner.save_latest_on)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
#[path = "session_manager/stash_tests.rs"]
mod stash_tests;
