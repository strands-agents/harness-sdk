//! The search backend over Amazon Bedrock AgentCore's `InvokeWebSearch` API, authorized by IAM.

use std::fmt;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use aws_config::meta::region::ProvideRegion;
use aws_config::profile::ProfileFileRegionProvider;
use aws_config::retry::RetryConfig;
use aws_config::timeout::TimeoutConfig;
use aws_config::{BehaviorVersion, Region, SdkConfig};
use aws_credential_types::provider::error::CredentialsError;
use aws_sdk_bedrockagentcore::Client;
use aws_sdk_bedrockagentcore::config::http::HttpResponse;
use aws_sdk_bedrockagentcore::error::{DisplayErrorContext, ProvideErrorMetadata, SdkError};
use aws_sdk_bedrockagentcore::operation::invoke_web_search::builders::InvokeWebSearchFluentBuilder;
use aws_sdk_bedrockagentcore::operation::invoke_web_search::{InvokeWebSearchError, InvokeWebSearchOutput};
use futures::future::BoxFuture;
use strands::tools::FunctionTool;
use tokio::sync::OnceCell;

use super::{SNIPPET_CHARS, SearchBackend, SearchResult, WebSearchError, one_line, search_tool};
use crate::env::Env;

const WEB_SEARCH_ID: &str = "web-search.v1";
/// `BedrockModel`'s fallback when neither the environment nor the profile names a region.
const DEFAULT_REGION: &str = "us-west-2";
const TIMEOUT: Duration = Duration::from_secs(30);
/// Bounded like the Exa path, instead of the SDK's 3 attempts per call.
const MAX_ATTEMPTS: u32 = 2;
/// Appended to a permanent failure's tool result, so the model stops retrying.
const ANSWER_WITHOUT_SEARCH: &str = " web_search is unavailable here; answer without it.";

/// Options for [`make_agent_core_web_search`] (`MakeAgentCoreWebSearchOptions`).
#[derive(Debug, Clone, Default, bon::Builder)]
#[builder(on(String, into))]
pub struct MakeAgentCoreWebSearchOptions {
    /// The AgentCore region; wins over `sdk_config`'s. Without either it is `AWS_REGION`, then
    /// `AWS_DEFAULT_REGION`, then the shared config profile's region, then `us-west-2`, the way
    /// the harness's Bedrock model resolves its own.
    pub region: Option<String>,
    /// The shared AWS config (credentials and the like) the client is built from; the default
    /// credential chain when absent.
    pub sdk_config: Option<SdkConfig>,
}

/// Why a call failed, as far as the backend cares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CallFailure {
    /// An unmodeled 404: the region has no such API.
    NotInRegion(String),
    /// The caller lacks `bedrock-agentcore:InvokeWebSearch`.
    AccessDenied(String),
    /// No AWS credentials to sign with.
    Credentials(String),
    /// Anything else; passed through to the model, and the next call tries again.
    Other(String),
}

/// One `InvokeWebSearch` call.
#[async_trait]
pub(crate) trait Invoke: Send + Sync {
    async fn invoke(&self, query: &str, max_results: usize) -> Result<Vec<SearchResult>, CallFailure>;
}

/// The client every search of one backend shares, with the region it was built for.
#[derive(Clone)]
pub(crate) struct Connection {
    pub(crate) invoke: Arc<dyn Invoke>,
    pub(crate) region: String,
}

type Connect = Arc<dyn Fn() -> BoxFuture<'static, Connection> + Send + Sync>;

/// The search backend over AgentCore web search (`agentCoreBackend`). A missing permission,
/// missing credentials, or an unsupported region is permanent, so it is remembered (and logged
/// once) and later searches fail without a request.
pub struct AgentCoreBackend {
    connect: Connect,
    connection: OnceCell<Connection>,
    unavailable: OnceLock<String>,
}

impl fmt::Debug for AgentCoreBackend {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AgentCoreBackend")
            .field(
                "region",
                &self.connection.get().map(|connection| connection.region.as_str()),
            )
            .field("unavailable", &self.unavailable.get())
            .finish_non_exhaustive()
    }
}

impl Default for AgentCoreBackend {
    fn default() -> Self {
        Self::new(MakeAgentCoreWebSearchOptions::default())
    }
}

impl AgentCoreBackend {
    /// A backend whose client is built on the first search.
    #[must_use]
    pub fn new(options: MakeAgentCoreWebSearchOptions) -> Self {
        Self::with_env(options, Env::process())
    }

    pub(crate) fn with_env(options: MakeAgentCoreWebSearchOptions, env: Env) -> Self {
        let options = Arc::new(options);
        Self::with_connect(Arc::new(move || {
            let options = Arc::clone(&options);
            let env = env.clone();
            Box::pin(async move {
                let region = resolve_region(&options, &env, profile_region()).await;
                let client = client_for(&options, &region).await;
                Connection {
                    invoke: Arc::new(client),
                    region,
                }
            })
        }))
    }

    pub(crate) fn with_connect(connect: Connect) -> Self {
        Self {
            connect,
            connection: OnceCell::new(),
            unavailable: OnceLock::new(),
        }
    }

    fn mark_unavailable(&self, reason: &str) -> WebSearchError {
        let message = self.unavailable.get_or_init(|| {
            tracing::warn!("web_search: AgentCore web search is unavailable, so every search will fail: {reason}");
            format!("{reason}{ANSWER_WITHOUT_SEARCH}")
        });
        WebSearchError::new(message.clone())
    }
}

#[async_trait]
impl SearchBackend for AgentCoreBackend {
    async fn search(&self, query: &str, max_results: usize) -> Result<Vec<SearchResult>, WebSearchError> {
        if let Some(message) = self.unavailable.get() {
            return Err(WebSearchError::new(message.clone()));
        }
        let connection = self.connection.get_or_init(|| (self.connect)()).await;
        let region = &connection.region;
        match connection.invoke.invoke(query, max_results).await {
            Ok(results) => Ok(results),
            Err(CallFailure::NotInRegion(reason)) => Err(self.mark_unavailable(&format!(
                "AgentCore web search is not available in {region} ({reason})."
            ))),
            Err(CallFailure::AccessDenied(reason)) => Err(self.mark_unavailable(&format!(
                "{reason} (the caller needs bedrock-agentcore:InvokeWebSearch on arn:aws:bedrock-agentcore:{region}:aws:tool/{WEB_SEARCH_ID})."
            ))),
            Err(CallFailure::Credentials(reason)) => Err(self.mark_unavailable(&format!(
                "{reason} (AgentCore web search is signed with AWS credentials; a Bedrock API key does not cover it)."
            ))),
            Err(CallFailure::Other(reason)) => Err(WebSearchError::new(reason)),
        }
    }
}

/// Builds a `web_search` tool over Amazon Bedrock AgentCore web search
/// (`makeAgentCoreWebSearch`). The credentials need `bedrock-agentcore:InvokeWebSearch`.
///
/// ```
/// use strands::Tool;
/// use strands_harness::tools::web_search::{MakeAgentCoreWebSearchOptions, make_agent_core_web_search};
///
/// let tool = make_agent_core_web_search(MakeAgentCoreWebSearchOptions::builder().region("us-east-1").build());
/// assert_eq!(tool.name(), "web_search");
/// ```
#[must_use]
pub fn make_agent_core_web_search(options: MakeAgentCoreWebSearchOptions) -> FunctionTool {
    search_tool(Arc::new(AgentCoreBackend::new(options)))
}

pub(crate) fn agent_core_web_search(env: &Env) -> FunctionTool {
    search_tool(Arc::new(AgentCoreBackend::with_env(
        MakeAgentCoreWebSearchOptions::default(),
        env.clone(),
    )))
}

fn profile_region() -> BoxFuture<'static, Option<String>> {
    Box::pin(async {
        ProfileFileRegionProvider::new()
            .region()
            .await
            .map(|region| region.to_string())
    })
}

/// The region: the option, then `sdk_config`'s, then `AWS_REGION`, `AWS_DEFAULT_REGION`, the
/// profile's, and `us-west-2`.
pub(crate) async fn resolve_region(
    options: &MakeAgentCoreWebSearchOptions,
    env: &Env,
    profile: BoxFuture<'static, Option<String>>,
) -> String {
    let configured = options
        .region
        .clone()
        .filter(|region| !region.is_empty())
        .or_else(|| {
            options
                .sdk_config
                .as_ref()
                .and_then(SdkConfig::region)
                .map(ToString::to_string)
        })
        .or_else(|| env.get("AWS_REGION"))
        .or_else(|| env.get("AWS_DEFAULT_REGION"));
    if let Some(region) = configured {
        return region;
    }
    profile.await.unwrap_or_else(|| DEFAULT_REGION.to_owned())
}

/// The client for `region`: `sdk_config` (or the default chain) with two attempts and a 30 s
/// bound on each call.
pub(crate) async fn client_for(options: &MakeAgentCoreWebSearchOptions, region: &str) -> Client {
    let sdk_config = match &options.sdk_config {
        Some(config) => config.clone(),
        None => {
            aws_config::defaults(BehaviorVersion::latest())
                .region(Region::new(region.to_owned()))
                .load()
                .await
        }
    };
    let timeouts = sdk_config
        .timeout_config()
        .map(TimeoutConfig::to_builder)
        .unwrap_or_default()
        .operation_timeout(TIMEOUT)
        .build();
    let config = aws_sdk_bedrockagentcore::config::Builder::from(&sdk_config)
        .region(Region::new(region.to_owned()))
        .retry_config(RetryConfig::standard().with_max_attempts(MAX_ATTEMPTS))
        .timeout_config(timeouts)
        .build();
    Client::from_conf(config)
}

#[async_trait]
impl Invoke for Client {
    async fn invoke(&self, query: &str, max_results: usize) -> Result<Vec<SearchResult>, CallFailure> {
        let output = request(self, query, max_results)
            .send()
            .await
            .map_err(|error| classify(&error))?;
        Ok(results(&output))
    }
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    reason = "max_results is clamped to 1..=10"
)]
pub(crate) fn request(client: &Client, query: &str, max_results: usize) -> InvokeWebSearchFluentBuilder {
    client
        .invoke_web_search()
        .web_search_id(WEB_SEARCH_ID)
        .search_query(query)
        .max_results(max_results as i32)
}

/// The results in rank order; an untitled page is titled by its URL.
pub(crate) fn results(output: &InvokeWebSearchOutput) -> Vec<SearchResult> {
    output
        .results()
        .iter()
        .map(|result| {
            let url = result.url().unwrap_or_default();
            let title = result.title().filter(|title| !title.is_empty()).unwrap_or(url);
            let snippet: String = one_line(result.text()).chars().take(SNIPPET_CHARS).collect();
            SearchResult::new(title, url, snippet)
        })
        .collect()
}

/// Sorts an SDK failure into what the backend does with it. A modeled
/// `ResourceNotFoundException` (e.g. an unknown web search id) is a 404 too; only the unmodeled
/// routing 404 means the region lacks the API.
pub(crate) fn classify(error: &SdkError<InvokeWebSearchError, HttpResponse>) -> CallFailure {
    let service = error.as_service_error();
    let reason = service
        .and_then(service_message)
        .map_or_else(|| DisplayErrorContext(error).to_string(), ToOwned::to_owned);
    let not_found = service.is_some_and(InvokeWebSearchError::is_resource_not_found_exception);
    if error.raw_response().is_some_and(|raw| raw.status().as_u16() == 404) && !not_found {
        return CallFailure::NotInRegion(reason);
    }
    if service.is_some_and(InvokeWebSearchError::is_access_denied_exception) {
        return CallFailure::AccessDenied(reason);
    }
    if let Some(credentials) = credentials_failure(error) {
        return CallFailure::Credentials(credentials);
    }
    CallFailure::Other(reason)
}

/// The exception's own message, then the response metadata's.
fn service_message(error: &InvokeWebSearchError) -> Option<&str> {
    let message = match error {
        InvokeWebSearchError::AccessDeniedException(exception) => exception.message(),
        InvokeWebSearchError::InternalServerException(exception) => exception.message(),
        InvokeWebSearchError::ResourceNotFoundException(exception) => exception.message(),
        InvokeWebSearchError::ServiceUnavailableException(exception) => Some(exception.message()),
        InvokeWebSearchError::ThrottlingException(exception) => exception.message(),
        InvokeWebSearchError::ValidationException(exception) => Some(exception.message()),
        _ => None,
    };
    message.or_else(|| error.message())
}

/// Why signing failed for lack of credentials, when the credentials provider's error is in the
/// source chain: its first line, without the list of providers tried.
fn credentials_failure(error: &(dyn std::error::Error + 'static)) -> Option<String> {
    let mut current = Some(error);
    while let Some(error) = current {
        if let Some(credentials) = error.downcast_ref::<CredentialsError>() {
            let text = DisplayErrorContext(credentials).to_string();
            let first = text.lines().next().unwrap_or_default();
            return Some(first.trim_end_matches(" Attempted:").to_owned());
        }
        current = error.source();
    }
    None
}

#[cfg(test)]
mod tests;
