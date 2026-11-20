//! The model router and its candidates.

use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use async_trait::async_trait;
use futures::future::BoxFuture;

use super::fallback_strategy::FallbackStrategy;
use super::strategy::{RoutingAttempt, RoutingContext, RoutingFailure, RoutingStrategy};
use crate::agent::{InvocationContext, InvocationState, LocalAgent};
use crate::error::{Error, Result};
use crate::hooks::{AfterInvocationEvent, AfterModelCallEvent, BeforeInvocationEvent, HookCallbackOptions, HookOrder};
use crate::middleware::{InvokeModelContext, InvokeModelStage, StageResult};
use crate::models::Model;
use crate::plugins::Plugin;
use crate::types::{JsonObject, Message, SystemPrompt, ToolSpec};

/// What a candidate routes to: a concrete model, or a nested router used as one opaque candidate.
#[derive(Clone)]
#[non_exhaustive]
pub enum CandidateModel {
    /// A concrete model.
    Model(Arc<dyn Model>),
    /// A nested router; it makes one selection and does not fail over for the outer router.
    Router(ModelRouter),
}

impl From<Arc<dyn Model>> for CandidateModel {
    fn from(model: Arc<dyn Model>) -> Self {
        Self::Model(model)
    }
}

impl<M: Model> From<M> for CandidateModel {
    fn from(model: M) -> Self {
        Self::Model(Arc::new(model))
    }
}

impl<M: Model> From<Arc<M>> for CandidateModel {
    fn from(model: Arc<M>) -> Self {
        Self::Model(model)
    }
}

impl From<ModelRouter> for CandidateModel {
    fn from(router: ModelRouter) -> Self {
        Self::Router(router)
    }
}

impl fmt::Debug for CandidateModel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Model(model) => f.debug_tuple("Model").field(&model.model_id()).finish(),
            Self::Router(router) => f.debug_tuple("Router").field(router).finish(),
        }
    }
}

/// How to build a [`RoutingCandidate`] (`RoutingCandidateOptions`): [`new`](Self::new) and the
/// `with_*` setters, or the builder.
#[derive(Debug, Clone, bon::Builder)]
#[non_exhaustive]
pub struct RoutingCandidateOptions {
    /// The model or nested router.
    #[builder(into)]
    pub model: CandidateModel,
    /// A name strategies see.
    #[builder(into)]
    pub name: Option<String>,
    /// A description strategies see.
    #[builder(into)]
    pub description: Option<String>,
    /// Evidence strategies see; classifier strategies send it to their provider, so it must not
    /// contain secrets.
    pub metadata: Option<JsonObject>,
}

impl RoutingCandidateOptions {
    /// Options with only the model.
    pub fn new(model: impl Into<CandidateModel>) -> Self {
        Self {
            model: model.into(),
            name: None,
            description: None,
            metadata: None,
        }
    }

    /// Sets the name.
    #[must_use]
    pub fn with_name(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }

    /// Sets the description.
    #[must_use]
    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Sets the metadata.
    #[must_use]
    pub fn with_metadata(mut self, metadata: JsonObject) -> Self {
        self.metadata = Some(metadata);
        self
    }
}

struct CandidateInner {
    model: CandidateModel,
    name: Option<String>,
    description: Option<String>,
    metadata: Option<JsonObject>,
}

/// A model or nested router with optional evidence for strategies (`RoutingCandidate`).
///
/// Immutable; clones are the same candidate, and candidates compare by identity, as strategies
/// must return one of the configured instances.
///
/// ```
/// use strands::models::routing::{RoutingCandidate, RoutingCandidateOptions};
/// use strands::testing::MockModel;
///
/// let candidate = RoutingCandidate::new(
///     RoutingCandidateOptions::new(MockModel::new())
///         .with_name("fast")
///         .with_description("Short factual requests"),
/// );
/// assert_eq!(candidate.name(), Some("fast"));
/// assert_eq!(candidate, candidate.clone());
/// ```
#[derive(Clone)]
pub struct RoutingCandidate(Arc<CandidateInner>);

impl RoutingCandidate {
    /// A candidate from its options.
    #[must_use]
    pub fn new(options: RoutingCandidateOptions) -> Self {
        Self(Arc::new(CandidateInner {
            model: options.model,
            name: options.name,
            description: options.description,
            metadata: options.metadata,
        }))
    }

    /// The model or nested router.
    #[must_use]
    pub fn model(&self) -> &CandidateModel {
        &self.0.model
    }

    /// The strategy-facing name.
    #[must_use]
    pub fn name(&self) -> Option<&str> {
        self.0.name.as_deref()
    }

    /// The strategy-facing description.
    #[must_use]
    pub fn description(&self) -> Option<&str> {
        self.0.description.as_deref()
    }

    /// The strategy-facing evidence.
    #[must_use]
    pub fn metadata(&self) -> Option<&JsonObject> {
        self.0.metadata.as_ref()
    }

    /// The name, or the model id when there is none.
    pub(crate) fn label(&self) -> String {
        if let Some(name) = self.name().filter(|name| !name.is_empty()) {
            return name.to_owned();
        }
        match self.model() {
            CandidateModel::Model(model) => model_label(model.as_ref()),
            CandidateModel::Router(_) => "ModelRouter".to_owned(),
        }
    }
}

impl PartialEq for RoutingCandidate {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

impl Eq for RoutingCandidate {}

impl fmt::Debug for RoutingCandidate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RoutingCandidate")
            .field("model", &self.0.model)
            .field("name", &self.0.name)
            .field("description", &self.0.description)
            .field("metadata", &self.0.metadata)
            .finish()
    }
}

impl From<RoutingCandidateOptions> for RoutingCandidate {
    fn from(options: RoutingCandidateOptions) -> Self {
        Self::new(options)
    }
}

impl From<CandidateModel> for RoutingCandidate {
    fn from(model: CandidateModel) -> Self {
        Self::new(RoutingCandidateOptions::new(model))
    }
}

impl From<Arc<dyn Model>> for RoutingCandidate {
    fn from(model: Arc<dyn Model>) -> Self {
        CandidateModel::from(model).into()
    }
}

impl<M: Model> From<M> for RoutingCandidate {
    fn from(model: M) -> Self {
        CandidateModel::from(model).into()
    }
}

impl<M: Model> From<Arc<M>> for RoutingCandidate {
    fn from(model: Arc<M>) -> Self {
        CandidateModel::from(model).into()
    }
}

impl From<ModelRouter> for RoutingCandidate {
    fn from(router: ModelRouter) -> Self {
        CandidateModel::from(router).into()
    }
}

/// Options of a [`ModelRouter`] (`ModelRouterOptions`).
#[derive(Clone, Default, bon::Builder)]
pub struct ModelRouterOptions {
    /// The strategy behind every routing decision. Defaults to [`FallbackStrategy`].
    pub strategy: Option<Arc<dyn RoutingStrategy>>,
    /// The most successful candidate switches per invocation.
    pub max_switches: Option<u32>,
}

impl fmt::Debug for ModelRouterOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ModelRouterOptions")
            .field("strategy", &self.strategy.as_ref().map(|strategy| strategy.name()))
            .field("max_switches", &self.max_switches)
            .finish()
    }
}

struct RouterInner {
    candidates: Vec<RoutingCandidate>,
    default_model: Arc<dyn Model>,
    strategy: Arc<dyn RoutingStrategy>,
    max_switches: Option<u32>,
}

/// Routes each invocation among a fixed set of candidate models (`ModelRouter`).
///
/// Pass it as the agent's model: the strategy picks the opening candidate before the first model
/// call (in model input middleware, so `BeforeModelCallEvent` reports the default model and
/// `AfterModelCallEvent` the routed one), and after each failure no retry strategy claimed it
/// picks the next. The attempt count restarts at 1 when the candidate changes. `agent.model()`
/// stays the first candidate's model, which token estimation and conversation management use.
/// The API is provisional.
///
/// ```
/// use strands::Agent;
/// use strands::models::routing::{ModelRouter, ModelRouterOptions};
/// use strands::testing::MockModel;
///
/// let router = ModelRouter::new(
///     [MockModel::new().with_turn("primary"), MockModel::new().with_turn("fallback")],
///     ModelRouterOptions::default(),
/// )?;
/// let agent = Agent::builder().model(router).printer(false).build()?;
/// # let _ = agent;
/// # Ok::<(), strands::Error>(())
/// ```
#[derive(Clone)]
pub struct ModelRouter(Arc<RouterInner>);

impl fmt::Debug for ModelRouter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ModelRouter")
            .field("candidates", &self.0.candidates.len())
            .field("strategy", &self.0.strategy.name())
            .field("max_switches", &self.0.max_switches)
            .finish()
    }
}

fn model_label(model: &dyn Model) -> String {
    model.model_id().unwrap_or_else(|| "Model".to_owned())
}

fn model_ptr(model: &Arc<dyn Model>) -> *const () {
    Arc::as_ptr(model).cast::<()>()
}

pub(crate) fn same_model(a: &Arc<dyn Model>, b: &Arc<dyn Model>) -> bool {
    std::ptr::eq(model_ptr(a), model_ptr(b))
}

fn reachable_models(candidate: &RoutingCandidate, models: &mut Vec<Arc<dyn Model>>) {
    match candidate.model() {
        CandidateModel::Model(model) => models.push(model.clone()),
        CandidateModel::Router(router) => {
            for nested in router.candidates() {
                reachable_models(nested, models);
            }
        }
    }
}

/// Rejects repeated candidates, repeated models (also through nested routers) and repeated names
/// at one level: a strategy tracks health per candidate, so one model behind two candidates would
/// get two failure budgets.
fn reject_duplicates(candidates: &[RoutingCandidate]) -> Result<()> {
    let mut seen_models: Vec<Arc<dyn Model>> = Vec::new();
    let mut seen_names: Vec<&str> = Vec::new();
    for (index, candidate) in candidates.iter().enumerate() {
        if candidates[..index].contains(candidate) {
            return Err(Error::other("duplicate RoutingCandidate instance"));
        }
        let mut models = Vec::new();
        reachable_models(candidate, &mut models);
        for model in models {
            if seen_models.iter().any(|seen| same_model(seen, &model)) {
                return Err(Error::other(format!(
                    "candidate=<{}> repeats a model already routed to; construct a separate instance so each candidate has its own health",
                    candidate.label()
                )));
            }
            seen_models.push(model);
        }
        let Some(name) = candidate.name() else {
            continue;
        };
        if seen_names.contains(&name) {
            return Err(Error::other(format!("duplicate candidate name=<{name}>")));
        }
        seen_names.push(name);
    }
    Ok(())
}

fn reject_stateful(candidates: &[RoutingCandidate]) -> Result<()> {
    for candidate in candidates {
        if let CandidateModel::Model(model) = candidate.model()
            && model.stateful()
        {
            return Err(Error::other(format!(
                "candidate=<{}> is stateful; routing among stateful models is not supported",
                candidate.label()
            )));
        }
    }
    Ok(())
}

impl ModelRouter {
    /// A router over `models`: models, nested routers or [`RoutingCandidate`]s, in declaration
    /// order.
    ///
    /// # Errors
    ///
    /// No candidates (`ModelRouter requires at least one candidate model`), a stateful model, a
    /// repeated candidate, model or name.
    pub fn new(
        models: impl IntoIterator<Item = impl Into<RoutingCandidate>>,
        options: ModelRouterOptions,
    ) -> Result<Self> {
        let candidates: Vec<RoutingCandidate> = models.into_iter().map(Into::into).collect();
        if candidates.is_empty() {
            return Err(Error::other("ModelRouter requires at least one candidate model"));
        }
        reject_stateful(&candidates)?;
        reject_duplicates(&candidates)?;
        let default_model = match candidates[0].model() {
            CandidateModel::Model(model) => model.clone(),
            CandidateModel::Router(router) => router.default_model(),
        };
        Ok(Self(Arc::new(RouterInner {
            candidates,
            default_model,
            strategy: options.strategy.unwrap_or_else(|| Arc::new(FallbackStrategy)),
            max_switches: options.max_switches,
        })))
    }

    /// The router's plugin name (`strands:model-router`).
    #[must_use]
    pub fn name(&self) -> &'static str {
        MODEL_ROUTER_NAME
    }

    /// The candidates, in declaration order.
    #[must_use]
    pub fn candidates(&self) -> &[RoutingCandidate] {
        &self.0.candidates
    }

    /// The first candidate's concrete model, found without asking a strategy.
    #[must_use]
    pub fn default_model(&self) -> Arc<dyn Model> {
        self.0.default_model.clone()
    }

    fn strategy_name(&self) -> &'static str {
        self.0.strategy.name()
    }

    /// A routing context over this router's candidates; every ask gets fresh copies.
    fn routing_context(
        &self,
        messages: Vec<Message>,
        system_prompt: Option<SystemPrompt>,
        tool_specs: Vec<ToolSpec>,
        invocation_state: InvocationState,
        invocation_context: Option<&InvocationContext>,
        attempts: Vec<RoutingAttempt>,
    ) -> RoutingContext {
        RoutingContext {
            messages,
            system_prompt,
            tool_specs,
            candidates: self.0.candidates.clone(),
            invocation_state,
            attempts,
            invocation_context: InvocationContext::auxiliary(invocation_context),
        }
    }

    fn nested_context(&self, context: &RoutingContext) -> RoutingContext {
        RoutingContext {
            candidates: self.0.candidates.clone(),
            attempts: Vec::new(),
            ..context.clone()
        }
    }

    fn validated(&self, candidate: Option<RoutingCandidate>) -> Result<Option<RoutingCandidate>> {
        match candidate {
            Some(candidate) if !self.0.candidates.contains(&candidate) => Err(Error::other(
                "strategy.select must return a candidate from context.candidates",
            )),
            candidate => Ok(candidate),
        }
    }

    async fn ask(&self, context: &RoutingContext) -> Result<Option<RoutingCandidate>> {
        let candidate = self.0.strategy.select(context).await.map_err(Error::from_boxed)?;
        self.validated(candidate)
    }

    /// Resolves a candidate to a model; a nested router selects once with no attempts.
    fn resolve<'r>(
        &'r self,
        candidate: &'r RoutingCandidate,
        context: &'r RoutingContext,
    ) -> BoxFuture<'r, Result<Arc<dyn Model>>> {
        Box::pin(async move {
            match candidate.model() {
                CandidateModel::Model(model) => Ok(model.clone()),
                CandidateModel::Router(router) => router.select_model(&router.nested_context(context)).await,
            }
        })
    }

    async fn select_model(&self, context: &RoutingContext) -> Result<Arc<dyn Model>> {
        match self.ask(context).await? {
            None => Ok(self.default_model()),
            Some(candidate) => self.resolve(&candidate, context).await,
        }
    }

    /// The opening choice (`_open`): a decline serves the default model; errors propagate.
    async fn open(&self, context: &RoutingContext) -> Result<(RoutingCandidate, Arc<dyn Model>)> {
        let strategy = self.strategy_name();
        let Some(candidate) = self.ask(context).await? else {
            let fallback = self.0.candidates[0].clone();
            let model = self.default_model();
            tracing::info!(
                "strategy=<{strategy}>, candidate=<{}>, model=<{}> | strategy declined the opening choice, using the default model",
                fallback.label(),
                model_label(model.as_ref())
            );
            return Ok((fallback, model));
        };
        let model = self.resolve(&candidate, context).await?;
        tracing::info!(
            "strategy=<{strategy}>, candidate=<{}>, model=<{}> | candidate selected",
            candidate.label(),
            model_label(model.as_ref())
        );
        Ok((candidate, model))
    }
}

/// The name of the router's plugin slot.
pub(crate) const MODEL_ROUTER_NAME: &str = "strands:model-router";

/// The router's slot, first in the built-in plugin order. The router registers its middleware
/// and hooks when the agent is built, so later middleware wraps it;
/// the slot keeps its plugin name taken.
pub(crate) struct ModelRouterPlugin;

#[async_trait]
impl Plugin for ModelRouterPlugin {
    fn name(&self) -> &str {
        MODEL_ROUTER_NAME
    }

    async fn init_agent(&self, _agent: &mut LocalAgent) -> Result<()> {
        Ok(())
    }
}

/// One invocation's candidate, attempts and switch accounting (`RoutingState`).
struct RoutingState {
    candidate: RoutingCandidate,
    model: Arc<dyn Model>,
    attempts: Vec<RoutingAttempt>,
    switched_to: Vec<RoutingCandidate>,
    switches: u32,
}

impl RoutingState {
    fn new(candidate: RoutingCandidate, model: Arc<dyn Model>) -> Self {
        Self {
            switched_to: vec![candidate.clone()],
            candidate,
            model,
            attempts: Vec::new(),
            switches: 0,
        }
    }
}

/// A router attached to one agent: the routing state of that agent's invocation lives here, not
/// in the caller's invocation state, and is cleared at both ends of every invocation.
#[derive(Clone)]
pub(crate) struct RouterAttachment {
    router: ModelRouter,
    state: Arc<Mutex<Option<RoutingState>>>,
}

impl RouterAttachment {
    /// Registers the selection middleware, the routing hook and the boundary cleanup on `agent`.
    pub(crate) fn attach(router: ModelRouter, agent: &LocalAgent) -> Self {
        let attachment = Self {
            router,
            state: Arc::default(),
        };
        let selection = attachment.clone();
        agent.add_middleware(InvokeModelStage::input(move |context| {
            let selection = selection.clone();
            async move { selection.select(context).await }
        }));
        let routing = attachment.clone();
        agent.add_async_hook_with::<AfterModelCallEvent<'_>>(
            move |event| {
                let routing = routing.clone();
                Box::pin(async move { routing.on_model_result(event).await })
            },
            HookCallbackOptions {
                order: HookOrder::MODEL_ROUTING,
            },
        );
        let after = attachment.clone();
        agent.add_hook_with(
            move |_: &mut AfterInvocationEvent<'_>| after.clear(),
            HookCallbackOptions {
                order: HookOrder::SDK_LAST,
            },
        );
        let before = attachment.clone();
        agent.add_hook_with(
            move |_: &mut BeforeInvocationEvent<'_>| before.clear(),
            HookCallbackOptions {
                order: HookOrder::SDK_FIRST,
            },
        );
        attachment
    }

    fn lock(&self) -> MutexGuard<'_, Option<RoutingState>> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The routed model of the current invocation, once the opening selection ran.
    pub(crate) fn routed_model(&self) -> Option<Arc<dyn Model>> {
        self.lock().as_ref().map(|state| state.model.clone())
    }

    fn clear(&self) {
        *self.lock() = None;
    }

    /// Applies the invocation's selection to the model call, opening one on the first call.
    async fn select(&self, mut context: InvokeModelContext) -> StageResult<InvokeModelContext> {
        if let Some(model) = self.routed_model() {
            context.model = model;
            return Ok(context);
        }
        let routing = self.router.routing_context(
            context.messages.clone(),
            context.system_prompt.clone(),
            context.tool_specs.clone(),
            context.invocation_state.clone(),
            context.invocation_context.as_ref(),
            Vec::new(),
        );
        let (candidate, model) = self.router.open(&routing).await?;
        *self.lock() = Some(RoutingState::new(candidate, model.clone()));
        context.model = model;
        Ok(context)
    }

    /// Records the outcome and, after a failure no hook claimed, switches to the strategy's next choice.
    async fn on_model_result(&self, event: &mut AfterModelCallEvent<'_>) {
        let Some(candidate) = self.lock().as_ref().map(|state| state.candidate.clone()) else {
            return;
        };
        if event.error().is_some_and(crate::agent::is_cancelled_error) {
            return;
        }
        if event.stop_data().is_some() {
            if let Some(state) = self.lock().as_mut() {
                state.attempts.push(RoutingAttempt::success(candidate.clone()));
                state.switched_to = vec![candidate];
            }
            return;
        }
        let Some(failure) = event.error().filter(|_| !event.retry()).map(RoutingFailure::from) else {
            return;
        };
        let capped = {
            let mut guard = self.lock();
            let Some(state) = guard.as_mut() else {
                return;
            };
            state.attempts.push(RoutingAttempt::failure(candidate, failure));
            self.router.0.max_switches.filter(|cap| state.switches >= *cap)
        };
        if let Some(cap) = capped {
            tracing::warn!("maxSwitches=<{cap}> | switch cap reached, leaving the error to surface");
            return;
        }
        if self.advance(event).await {
            event.set_retry(true);
        }
    }

    fn attempts(&self) -> Vec<RoutingAttempt> {
        self.lock()
            .as_ref()
            .map(|state| state.attempts.clone())
            .unwrap_or_default()
    }

    fn used_this_round(&self, candidate: &RoutingCandidate) -> bool {
        self.lock()
            .as_ref()
            .is_some_and(|state| state.switched_to.contains(candidate))
    }

    /// Switches to the strategy's next candidate; returns whether to retry (`_advance`).
    ///
    /// Every pass either switches or uses up a slot of the round, so a round is bounded by the
    /// candidate count.
    async fn advance(&self, event: &AfterModelCallEvent<'_>) -> bool {
        let strategy = self.router.strategy_name();
        loop {
            let agent = event.agent();
            let context = self.router.routing_context(
                agent.messages().to_vec(),
                agent.system_prompt().cloned(),
                agent.tool_registry().tool_specs(),
                event.invocation_state().clone(),
                event.invocation_context(),
                self.attempts(),
            );
            // The model error is pending, so a failing or broken strategy must not replace it.
            let candidate = match self.router.ask(&context).await {
                Ok(candidate) => candidate,
                Err(error) => {
                    tracing::warn!(
                        "strategy=<{strategy}>, error=<{error}> | routing failed, leaving the error to surface"
                    );
                    return false;
                }
            };
            let Some(candidate) = candidate else {
                return false;
            };
            if self.used_this_round(&candidate) {
                tracing::info!(
                    "candidate=<{}> | already used this round, leaving the error to surface",
                    candidate.label()
                );
                return false;
            }
            let model = match self.router.resolve(&candidate, &context).await {
                Ok(model) => model,
                Err(error) => {
                    tracing::warn!(
                        "candidate=<{}>, error=<{error}> | candidate could not be resolved, asking again",
                        candidate.label()
                    );
                    if let Some(state) = self.lock().as_mut() {
                        state
                            .attempts
                            .push(RoutingAttempt::failure(candidate.clone(), RoutingFailure::from(&error)));
                        state.switched_to.push(candidate);
                    }
                    continue;
                }
            };
            let mut guard = self.lock();
            let Some(state) = guard.as_mut() else {
                return false;
            };
            tracing::info!(
                "from_candidate=<{}>, to_candidate=<{}>, error=<{}> | model call failed, switching candidate",
                state.candidate.label(),
                candidate.label(),
                event.error().map_or("undefined", Error::name)
            );
            state.switched_to.push(candidate.clone());
            state.candidate = candidate;
            state.model = model;
            state.switches += 1;
            return true;
        }
    }
}

#[cfg(test)]
mod tests;
