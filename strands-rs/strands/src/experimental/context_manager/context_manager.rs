//! The context manager: strategy-driven context reduction, offloading to the stash and overflow
//! recovery.

use std::collections::HashSet;
use std::fmt;
use std::str::FromStr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use async_trait::async_trait;

use super::methods::truncate::TruncateConfig;
use super::presets::resolve_strategies;
use super::retrieval_tool::{create_retrieval_tool, track_retrieval_tool_use_ids};
use super::stash::Stash;
use super::strategies::offload::{
    EmergencyTruncateStrategy, Offload, OffloadConditions, OffloadTarget, SummarizeConfig,
};
use super::types::{ContextManagerConfig, ContextState, ContextStrategy, StashConfig};
use crate::agent::{InvocationContext, LocalAgent};
use crate::error::{Error, Result};
use crate::hooks::{AfterModelCallEvent, BeforeModelCallEvent, MessageAddedEvent};
use crate::models::model_proxy::ModelProxy;
use crate::models::{CountTokensOptions, Model};
use crate::plugins::Plugin;
use crate::storage::{InMemoryStorage, Storage};
use crate::tools::ToolSource;
use crate::types::Toggle;

const AUTO_TRUNCATE_THRESHOLD: f64 = 1_500.0;
const AGENTIC_TRUNCATE_THRESHOLD: f64 = 8_000.0;
const TRUNCATE_PREVIEW_TOKENS: f64 = 750.0;
const AUTO_SUMMARIZE_UTILIZATION: f64 = 0.85;
const MAX_OVERFLOW_RETRIES: u32 = 3;

/// The plugin name (`name`).
pub(crate) const CONTEXT_MANAGER_NAME: &str = "strands:context-manager";

/// What `AgentConfig::context_manager` accepts (`ContextManagerStrategy`).
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum ContextManagerStrategy {
    /// Proactive truncation of tool results and summarization at 85% utilization (`'auto'`).
    Auto,
    /// Model-driven context management through the `summarize_context`, `truncate_context` and
    /// `pin_context` tools, a higher truncation threshold and summarization only on overflow
    /// (`'agentic'`, experimental).
    Agentic,
    /// A custom pipeline and stash.
    Config(ContextManagerConfig),
    /// An instance, used as is (a handle: clones share the manager).
    Instance(ContextManager),
    /// No context management: no compression, no offloading (`false`).
    Disabled,
}

impl From<ContextManagerConfig> for ContextManagerStrategy {
    fn from(config: ContextManagerConfig) -> Self {
        Self::Config(config)
    }
}

impl From<ContextManager> for ContextManagerStrategy {
    fn from(manager: ContextManager) -> Self {
        Self::Instance(manager)
    }
}

impl From<Arc<ContextManager>> for ContextManagerStrategy {
    fn from(manager: Arc<ContextManager>) -> Self {
        Self::Instance((*manager).clone())
    }
}

impl FromStr for ContextManagerStrategy {
    type Err = Error;

    /// Parses a preset name, `auto` or `agentic`.
    fn from_str(preset: &str) -> Result<Self> {
        match preset {
            "auto" => Ok(Self::Auto),
            "agentic" => Ok(Self::Agentic),
            other => Err(Error::other(format!(
                "Unknown contextManager preset: \"{other}\". Valid presets: \"auto\", \"agentic\""
            ))),
        }
    }
}

#[derive(Clone)]
enum StashStorage {
    Default,
    Explicit(Arc<dyn Storage>),
    Disabled,
}

/// Manages context reduction for an agent's conversation (`ContextManager`, experimental).
///
/// Before each model call it runs its strategy pipeline; on a context window overflow it runs
/// the pipeline in recovery mode and retries the call, up to three times. An emergency truncation
/// always runs last and fires only when the window still overflows. Offloaded content is stashed,
/// and the `retrieve_context` tool lets the model read it back.
///
/// Configure it through `AgentConfig::context_manager`; with one present no separate
/// conversation manager is needed. Cheap to clone: clones are handles to the same manager and
/// compare equal; separately built managers never do.
///
/// ```
/// use strands::Agent;
/// use strands::experimental::context_manager::ContextManagerStrategy;
/// use strands::testing::MockModel;
///
/// let agent = Agent::builder()
///     .model(MockModel::new().with_turn("Hi"))
///     .context_manager(ContextManagerStrategy::Auto)
///     .printer(false)
///     .build()?;
/// # let _ = agent;
/// # Ok::<(), strands::Error>(())
/// ```
#[derive(Clone)]
pub struct ContextManager {
    strategies: Arc<[Arc<dyn ContextStrategy>]>,
    stash_storage: StashStorage,
    enable_retrieval_tool: bool,
    retrieval_tool_use_ids: Arc<Mutex<HashSet<String>>>,
    last_stash: Arc<Mutex<Option<AgentStash>>>,
}

/// The stash a context manager made for one agent, kept on that agent so its hooks, strategies,
/// retrieval tool and session manager use it even when the manager serves several agents.
#[derive(Clone, Debug)]
pub(crate) struct AgentStash {
    pub(crate) stash: Stash,
    pub(crate) durable: bool,
}

impl PartialEq for ContextManager {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.last_stash, &other.last_stash)
    }
}

impl Eq for ContextManager {}

impl fmt::Debug for ContextManager {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let strategies: Vec<&str> = self.strategies.iter().map(|strategy| strategy.name()).collect();
        f.debug_struct("ContextManager")
            .field("strategies", &strategies)
            .field("stash", &self.stash())
            .finish_non_exhaustive()
    }
}

fn default_strategies(truncate_threshold: f64, summarize_utilization: f64) -> Result<Vec<Arc<dyn ContextStrategy>>> {
    let truncate = Offload::truncate(
        OffloadTarget::ToolResults,
        TruncateConfig {
            preview_tokens: Some(TRUNCATE_PREVIEW_TOKENS),
            ..TruncateConfig::default()
        },
    )?
    .when(OffloadConditions {
        threshold: Some(truncate_threshold),
        ..OffloadConditions::default()
    })?;
    let summarize = Offload::summarize(OffloadTarget::All, SummarizeConfig::default())?.when(OffloadConditions {
        utilization: Some(summarize_utilization),
        preserve_recent: Some(4.0),
        ..OffloadConditions::default()
    });
    Ok(vec![Arc::new(truncate), Arc::new(summarize)])
}

/// Runs the pipeline once; a failing strategy is logged and the next runs.
async fn run_strategies(
    strategies: &[Arc<dyn ContextStrategy>],
    stash: Option<Stash>,
    agent: &mut LocalAgent,
    precomputed_input_tokens: Option<u64>,
    overflow: bool,
    invocation_context: Option<&InvocationContext>,
) -> Result<bool> {
    let model = agent.model().clone();
    let proxy = ModelProxy::new(model.clone());
    let input_tokens = match precomputed_input_tokens {
        Some(tokens) => tokens,
        None => {
            proxy
                .count_tokens(agent.messages(), CountTokensOptions::default())
                .await?
        }
    };
    let agent_id = agent.id().to_owned();
    let mut state = ContextState::new(agent, model.estimate_utilization(input_tokens))
        .with_overflow(overflow)
        .with_stash(stash)
        .with_invocation_context(InvocationContext::auxiliary(invocation_context));
    let mut any_acted = false;
    for strategy in strategies {
        if any_acted && strategy.name() == "offload:emergency-truncate" {
            state.overflow = false;
        }
        let applied = apply_strategy(strategy.as_ref(), &mut state, &proxy, &model, &mut any_acted).await;
        if let Err(error) = applied {
            tracing::warn!(
                "strategy=<{}>, agent_id=<{agent_id}>, error=<{error}> | strategy failed, continuing",
                strategy.name()
            );
        }
    }
    Ok(any_acted)
}

/// Applies one strategy and, when it acted, recounts the utilization; a recount that fails counts
/// as the strategy failing, after it acted.
async fn apply_strategy(
    strategy: &dyn ContextStrategy,
    state: &mut ContextState<'_>,
    proxy: &ModelProxy,
    model: &Arc<dyn Model>,
    any_acted: &mut bool,
) -> Result<()> {
    if !strategy.apply(state).await? {
        return Ok(());
    }
    *any_acted = true;
    let tokens = proxy
        .count_tokens(state.agent.messages(), CountTokensOptions::default())
        .await?;
    state.utilization = model.estimate_utilization(tokens);
    tracing::debug!(
        "strategy=<{}>, agent_id=<{}> | strategy applied",
        strategy.name(),
        state.agent.id()
    );
    Ok(())
}

impl ContextManager {
    /// Creates a context manager (`new ContextManager(config)`).
    ///
    /// # Errors
    ///
    /// A preset that does not resolve.
    pub fn new(config: ContextManagerConfig) -> Result<Self> {
        let mut strategies = match &config.strategies {
            Some(entries) => resolve_strategies(entries)?,
            None => default_strategies(AUTO_TRUNCATE_THRESHOLD, AUTO_SUMMARIZE_UTILIZATION)?,
        };
        strategies.push(Arc::new(EmergencyTruncateStrategy::new()));
        let stash = config.stash.unwrap_or_else(|| Toggle::On(StashConfig::default()));
        let (stash_storage, enable_retrieval_tool) = match stash.into_option() {
            None => (StashStorage::Disabled, false),
            Some(stash) => (
                stash.storage.map_or(StashStorage::Default, StashStorage::Explicit),
                stash.retrieval_tool != Some(false),
            ),
        };
        Ok(Self {
            strategies: strategies.into(),
            stash_storage,
            enable_retrieval_tool,
            retrieval_tool_use_ids: Arc::default(),
            last_stash: Arc::default(),
        })
    }

    /// The `agentic` preset's manager: tool results truncated over 8,000 tokens and
    /// summarization only on overflow.
    fn agentic() -> Result<Self> {
        let mut manager = Self::new(ContextManagerConfig::default())?;
        let mut strategies = default_strategies(AGENTIC_TRUNCATE_THRESHOLD, 1.0)?;
        strategies.push(Arc::new(EmergencyTruncateStrategy::new()));
        manager.strategies = strategies.into();
        Ok(manager)
    }

    /// Resolves a strategy value to a manager (`ContextManager.from`): an instance as is, a new
    /// manager for a preset or a configuration, and `None` for `Disabled` or no value.
    ///
    /// # Errors
    ///
    /// A configuration whose presets do not resolve.
    pub fn from_strategy(strategy: Option<ContextManagerStrategy>) -> Result<Option<Self>> {
        Ok(match strategy {
            None | Some(ContextManagerStrategy::Disabled) => None,
            Some(ContextManagerStrategy::Instance(manager)) => Some(manager),
            Some(ContextManagerStrategy::Auto) => Some(Self::new(ContextManagerConfig::default())?),
            Some(ContextManagerStrategy::Agentic) => Some(Self::agentic()?),
            Some(ContextManagerStrategy::Config(config)) => Some(Self::new(config)?),
        })
    }

    /// A manager whose stash is `stash`, for session tests that stand in for an attached one.
    #[cfg(test)]
    pub(crate) fn with_test_stash(stash: Stash, durable: bool) -> Result<Self> {
        let manager = Self::new(ContextManagerConfig::default())?;
        *manager.lock_last_stash() = Some(AgentStash { stash, durable });
        Ok(manager)
    }

    /// The stash, once the manager is attached to an agent and the stash is enabled (`stash`).
    ///
    /// A manager shared by several agents gives each agent its own stash; this returns the one
    /// made for the agent attached last.
    #[must_use]
    pub fn stash(&self) -> Option<Stash> {
        self.lock_last_stash()
            .as_ref()
            .map(|agent_stash| agent_stash.stash.clone())
    }

    /// Whether the stash is on storage that outlives the process, so session snapshots need not
    /// embed its data. For a shared manager, of the agent attached last.
    #[must_use]
    pub fn stash_is_durable(&self) -> bool {
        self.lock_last_stash()
            .as_ref()
            .is_some_and(|agent_stash| agent_stash.durable)
    }

    fn lock_last_stash(&self) -> MutexGuard<'_, Option<AgentStash>> {
        self.last_stash.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn resolve_stash(&self, agent: &LocalAgent) -> Result<Option<AgentStash>> {
        let (storage, custom_namespace): (Arc<dyn Storage>, bool) = match &self.stash_storage {
            StashStorage::Disabled => return Ok(None),
            StashStorage::Explicit(storage) => (storage.clone(), true),
            StashStorage::Default => (
                agent
                    .storage()
                    .cloned()
                    .unwrap_or_else(|| Arc::new(InMemoryStorage::new())),
                false,
            ),
        };
        let durable = !storage.is_ephemeral();
        let stash = Stash::with_namespace(storage, agent.session_id(), agent.id(), custom_namespace)?;
        Ok(Some(AgentStash { stash, durable }))
    }
}

/// Overflow recovery: reruns the pipeline and retries the call, at most three times in a row.
async fn on_overflow(
    strategies: Arc<[Arc<dyn ContextStrategy>]>,
    stash: Option<Stash>,
    retries: Arc<AtomicU32>,
    event: &mut AfterModelCallEvent<'_>,
) -> Result<()> {
    if !matches!(event.error(), Some(Error::ContextWindowOverflow(_))) {
        retries.store(0, Ordering::Relaxed);
        return Ok(());
    }
    let agent_id = event.agent().id().to_owned();
    if retries.load(Ordering::Relaxed) >= MAX_OVERFLOW_RETRIES {
        tracing::warn!("agent_id=<{agent_id}> | overflow retry limit reached, giving up");
        retries.store(0, Ordering::Relaxed);
        return Ok(());
    }
    let invocation_context = event.invocation_context().cloned();
    let acted = run_strategies(
        &strategies,
        stash,
        event.agent_mut(),
        None,
        true,
        invocation_context.as_ref(),
    )
    .await?;
    if !acted {
        tracing::warn!("agent_id=<{agent_id}> | no strategy made progress, skipping retry");
        return Ok(());
    }
    retries.fetch_add(1, Ordering::Relaxed);
    event.set_retry(true);
    Ok(())
}

#[async_trait]
impl Plugin for ContextManager {
    fn name(&self) -> &str {
        CONTEXT_MANAGER_NAME
    }

    fn get_tools(&self) -> Vec<ToolSource> {
        if !self.enable_retrieval_tool {
            return Vec::new();
        }
        let Some(stash) = self.stash() else {
            return Vec::new();
        };
        vec![ToolSource::from(create_retrieval_tool(stash))]
    }

    async fn init_agent(&self, agent: &mut LocalAgent) -> Result<()> {
        let agent_stash = self.resolve_stash(agent)?;
        agent.set_context_stash(agent_stash.clone());
        *self.lock_last_stash() = agent_stash.clone();
        let stash = agent_stash.map(|agent_stash| agent_stash.stash);
        if let Some(stash) = stash.clone() {
            for message in agent.messages().to_vec() {
                let skip = {
                    let mut skip = self
                        .retrieval_tool_use_ids
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner);
                    track_retrieval_tool_use_ids(&message, &mut skip);
                    skip.clone()
                };
                stash.store_message(&message, Some(&skip)).await;
            }
            let skip_ids = self.retrieval_tool_use_ids.clone();
            agent.add_async_hook::<MessageAddedEvent<'_>>(move |event| {
                let stash = stash.clone();
                let skip_ids = skip_ids.clone();
                Box::pin(async move {
                    let message = event.message().clone();
                    let skip = {
                        let mut skip = skip_ids.lock().unwrap_or_else(PoisonError::into_inner);
                        track_retrieval_tool_use_ids(&message, &mut skip);
                        skip.clone()
                    };
                    stash.store_message(&message, Some(&skip)).await;
                })
            });
        }
        for strategy in self.strategies.iter() {
            strategy.init(agent, stash.as_ref());
        }
        let strategies = self.strategies.clone();
        let before_stash = stash.clone();
        agent.add_async_hook::<BeforeModelCallEvent<'_>>(move |event| {
            let strategies = strategies.clone();
            let stash = before_stash.clone();
            Box::pin(async move {
                let projected = event.projected_input_tokens();
                let invocation_context = event.invocation_context().cloned();
                run_strategies(
                    &strategies,
                    stash,
                    event.agent_mut(),
                    projected,
                    false,
                    invocation_context.as_ref(),
                )
                .await
                .map(drop)
            })
        });
        let strategies = self.strategies.clone();
        let retries = Arc::new(AtomicU32::new(0));
        agent.add_async_hook::<AfterModelCallEvent<'_>>(move |event| {
            let strategies = strategies.clone();
            let stash = stash.clone();
            let retries = retries.clone();
            Box::pin(async move { on_overflow(strategies, stash, retries, event).await })
        });
        Ok(())
    }
}

impl crate::Agent {
    /// The resolved context manager, when `AgentConfig::context_manager` set a preset, a
    /// configuration or an instance. Experimental, like the
    /// [`context_manager`](crate::experimental::context_manager) module: it may change in a minor
    /// release.
    #[must_use]
    pub fn context_manager(&self) -> Option<&ContextManager> {
        self.local.context_manager()
    }
}

#[cfg(test)]
#[path = "context_manager/tests.rs"]
mod tests;

#[cfg(test)]
#[path = "context_manager/agent_tests.rs"]
mod agent_tests;
