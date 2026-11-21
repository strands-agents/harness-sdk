use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use aws_config::{BehaviorVersion, SdkConfig};
use aws_credential_types::Credentials;
use aws_credential_types::provider::error::CredentialsError;
use aws_credential_types::provider::{ProvideCredentials, SharedCredentialsProvider};
use aws_sdk_bedrockagentcore::config::http::HttpResponse;
use aws_sdk_bedrockagentcore::error::SdkError;
use aws_sdk_bedrockagentcore::operation::invoke_web_search::{InvokeWebSearchError, InvokeWebSearchOutput};
use aws_sdk_bedrockagentcore::primitives::SdkBody;
use aws_sdk_bedrockagentcore::types::WebSearchResult;
use aws_sdk_bedrockagentcore::types::error::{AccessDeniedException, ResourceNotFoundException, ThrottlingException};
use aws_smithy_runtime_api::http::StatusCode;
use serde_json::{Value, json};
use strands::Tool;
use strands::testing::tool_context;
use strands::types::{ToolResultContent, ToolUse};

use super::*;
use crate::test_support::record_logs;

async fn invoke(tool: &FunctionTool, input: Value) -> String {
    let outcome =
        futures::StreamExt::collect::<Vec<_>>(tool.stream(tool_context(ToolUse::new("web_search", "t-1", input))))
            .await
            .pop()
            .unwrap();
    let strands::ToolStreamItem::Outcome(strands::ToolOutcome::Result(result)) = outcome else {
        panic!("expected a result");
    };
    match result.content.as_slice() {
        [ToolResultContent::Text(text)] => text.text.clone(),
        other => panic!("expected text, got {other:?}"),
    }
}

fn env(vars: &[(&str, &str)]) -> Env {
    let vars: HashMap<String, String> = vars.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
    Env::new(move |name| vars.get(name).cloned())
}

fn no_profile() -> BoxFuture<'static, Option<String>> {
    Box::pin(async { None })
}

/// Plays one outcome per call and records each `max_results`.
struct Scripted {
    outcomes: Mutex<Vec<Result<Vec<SearchResult>, CallFailure>>>,
    calls: Arc<Mutex<Vec<(String, usize)>>>,
}

#[async_trait]
impl Invoke for Scripted {
    async fn invoke(&self, query: &str, max_results: usize) -> Result<Vec<SearchResult>, CallFailure> {
        self.calls.lock().unwrap().push((query.to_owned(), max_results));
        self.outcomes.lock().unwrap().remove(0)
    }
}

struct Harnessed {
    tool: FunctionTool,
    calls: Arc<Mutex<Vec<(String, usize)>>>,
    connects: Arc<AtomicUsize>,
}

fn scripted(region: &str, outcomes: Vec<Result<Vec<SearchResult>, CallFailure>>) -> Harnessed {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let connects = Arc::new(AtomicUsize::new(0));
    let invoke: Arc<dyn Invoke> = Arc::new(Scripted {
        outcomes: Mutex::new(outcomes),
        calls: Arc::clone(&calls),
    });
    let region = region.to_owned();
    let counter = Arc::clone(&connects);
    let backend = AgentCoreBackend::with_connect(Arc::new(move || {
        counter.fetch_add(1, Ordering::SeqCst);
        let connection = Connection {
            invoke: Arc::clone(&invoke),
            region: region.clone(),
        };
        Box::pin(async move { connection })
    }));
    Harnessed {
        tool: search_tool(Arc::new(backend)),
        calls,
        connects,
    }
}

fn sdk_config(region: Option<&str>) -> SdkConfig {
    let mut builder = SdkConfig::builder()
        .behavior_version(BehaviorVersion::latest())
        .credentials_provider(SharedCredentialsProvider::new(Credentials::new(
            "AKIDTEST", "test", None, None, "test",
        )));
    if let Some(region) = region {
        builder = builder.region(Region::new(region.to_owned()));
    }
    builder.build()
}

fn response(status: u16) -> HttpResponse {
    HttpResponse::new(StatusCode::try_from(status).unwrap(), SdkBody::empty())
}

#[tokio::test]
async fn calls_invoke_web_search_in_the_bedrock_region_and_formats_the_results() {
    let options = MakeAgentCoreWebSearchOptions::default();
    assert_eq!(
        resolve_region(&options, &env(&[("AWS_REGION", "us-east-2")]), no_profile()).await,
        "us-east-2"
    );

    let options = MakeAgentCoreWebSearchOptions::builder()
        .sdk_config(sdk_config(None))
        .build();
    let client = client_for(&options, "us-east-2").await;
    assert_eq!(
        client.config().region().map(ToString::to_string).as_deref(),
        Some("us-east-2")
    );
    let request = request(&client, "strands agents", 10);
    let input = request.as_input();
    assert_eq!(input.get_web_search_id().as_deref(), Some("web-search.v1"));
    assert_eq!(input.get_search_query().as_deref(), Some("strands agents"));
    assert_eq!(*input.get_max_results(), Some(10));

    let output = InvokeWebSearchOutput::builder()
        .results(
            WebSearchResult::builder()
                .title("Strands")
                .url("https://strandsagents.com")
                .text(format!("Build   agents\nfast. {}", "x".repeat(600)))
                .build()
                .unwrap(),
        )
        .results(
            WebSearchResult::builder()
                .url("https://untitled.example")
                .text("no title")
                .build()
                .unwrap(),
        )
        .build()
        .unwrap();
    let harnessed = scripted("us-east-2", vec![Ok(results(&output))]);
    let out = invoke(&harnessed.tool, json!({"query": "strands agents", "max_results": 50})).await;

    assert_eq!(
        *harnessed.calls.lock().unwrap(),
        vec![("strands agents".to_owned(), 10)]
    );
    let lines: Vec<&str> = out.split('\n').collect();
    assert_eq!(
        lines[..2],
        ["Sources:", "1. Strands \u{2014} https://strandsagents.com"]
    );
    assert!(lines[2].starts_with("   Build agents fast. xxx"));
    assert_eq!(lines[2].chars().count(), 3 + 500);
    assert_eq!(
        lines[3..],
        [
            "2. https://untitled.example \u{2014} https://untitled.example",
            "   no title"
        ]
    );
}

#[tokio::test]
async fn uses_an_explicit_region_and_one_client_across_searches() {
    let options = MakeAgentCoreWebSearchOptions::builder().region("eu-west-1").build();
    assert_eq!(
        resolve_region(&options, &env(&[("AWS_REGION", "us-east-1")]), no_profile()).await,
        "eu-west-1"
    );

    let harnessed = scripted("eu-west-1", vec![Ok(Vec::new()), Ok(Vec::new())]);
    assert_eq!(invoke(&harnessed.tool, json!({"query": "q"})).await, "No results.");
    assert_eq!(invoke(&harnessed.tool, json!({"query": "q"})).await, "No results.");
    assert_eq!(harnessed.connects.load(Ordering::SeqCst), 1);

    let options = MakeAgentCoreWebSearchOptions::builder()
        .sdk_config(sdk_config(None))
        .build();
    let client = client_for(&options, "eu-west-1").await;
    // Bounded like the Exa path: two attempts, and each call carries a timeout.
    let config = client.config();
    assert_eq!(
        config.retry_config().map(aws_config::retry::RetryConfig::max_attempts),
        Some(2)
    );
    assert_eq!(
        config.timeout_config().and_then(TimeoutConfig::operation_timeout),
        Some(Duration::from_secs(30))
    );
}

#[tokio::test]
async fn names_the_iam_permission_on_access_denied_in_the_default_region_and_stops_calling() {
    let options = MakeAgentCoreWebSearchOptions::default();
    let region = resolve_region(
        &options,
        &env(&[("AWS_REGION", ""), ("AWS_DEFAULT_REGION", "")]),
        no_profile(),
    )
    .await;
    assert_eq!(region, "us-west-2");

    let harnessed = scripted(
        &region,
        vec![Err(CallFailure::AccessDenied(
            "the request is not authorized".to_owned(),
        ))],
    );
    let expected = concat!(
        "web_search failed: the request is not authorized (the caller needs bedrock-agentcore:InvokeWebSearch on ",
        "arn:aws:bedrock-agentcore:us-west-2:aws:tool/web-search.v1). web_search is unavailable here; answer without it."
    );
    assert_eq!(invoke(&harnessed.tool, json!({"query": "q"})).await, expected);
    assert_eq!(invoke(&harnessed.tool, json!({"query": "q"})).await, expected);
    assert_eq!(harnessed.calls.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn names_an_unsupported_region_when_the_service_has_no_such_path_there_and_stops_calling() {
    let harnessed = scripted(
        "eu-central-1",
        vec![Err(CallFailure::NotInRegion("Unexpected token".to_owned()))],
    );
    let expected = concat!(
        "web_search failed: AgentCore web search is not available in eu-central-1 (Unexpected token). ",
        "web_search is unavailable here; answer without it."
    );
    assert_eq!(invoke(&harnessed.tool, json!({"query": "q"})).await, expected);
    assert_eq!(invoke(&harnessed.tool, json!({"query": "q"})).await, expected);
    assert_eq!(harnessed.calls.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn says_when_there_are_no_aws_credentials_warns_once_and_stops_calling() {
    let (logs, _guard) = record_logs();
    let harnessed = scripted(
        "us-east-1",
        vec![Err(CallFailure::Credentials("Could not load credentials".to_owned()))],
    );
    let expected = concat!(
        "web_search failed: Could not load credentials (AgentCore web search is signed with AWS credentials; ",
        "a Bedrock API key does not cover it). web_search is unavailable here; answer without it."
    );
    assert_eq!(invoke(&harnessed.tool, json!({"query": "q"})).await, expected);
    assert_eq!(invoke(&harnessed.tool, json!({"query": "q"})).await, expected);
    assert_eq!(harnessed.calls.lock().unwrap().len(), 1);
    let warnings: Vec<String> = logs
        .lines("WARN")
        .into_iter()
        .filter(|line| line.contains("AgentCore web search is unavailable"))
        .collect();
    assert_eq!(warnings.len(), 1);
}

/// Counts how often the client asks for credentials.
#[derive(Debug)]
struct Counting(Arc<AtomicUsize>);

impl ProvideCredentials for Counting {
    fn provide_credentials<'a>(&'a self) -> aws_credential_types::provider::future::ProvideCredentials<'a>
    where
        Self: 'a,
    {
        self.0.fetch_add(1, Ordering::SeqCst);
        aws_credential_types::provider::future::ProvideCredentials::ready(Ok(Credentials::new(
            "AKIDEXAMPLE",
            "secret",
            None,
            None,
            "test",
        )))
    }
}

#[tokio::test]
async fn passes_sdk_config_to_the_agentcore_client() {
    let asked = Arc::new(AtomicUsize::new(0));
    let config = SdkConfig::builder()
        .behavior_version(BehaviorVersion::latest())
        .credentials_provider(SharedCredentialsProvider::new(Counting(Arc::clone(&asked))))
        .endpoint_url("http://127.0.0.1:9")
        .build();
    let options = MakeAgentCoreWebSearchOptions::builder()
        .region("us-east-1")
        .sdk_config(config)
        .build();
    let client = client_for(&options, "us-east-1").await;
    // The request is signed with the config's credentials before the (refused) connection.
    assert!(client.invoke("q", 1).await.is_err());
    assert!(asked.load(Ordering::SeqCst) > 0);
}

#[tokio::test]
async fn takes_the_region_from_sdk_config_like_bedrock_model_with_region_winning() {
    let env = env(&[("AWS_REGION", "eu-west-1")]);
    let from_config = MakeAgentCoreWebSearchOptions::builder()
        .sdk_config(sdk_config(Some("us-east-1")))
        .build();
    let explicit = MakeAgentCoreWebSearchOptions::builder()
        .region("ap-south-1")
        .sdk_config(sdk_config(Some("us-east-1")))
        .build();
    assert_eq!(
        [
            resolve_region(&from_config, &env, no_profile()).await,
            resolve_region(&explicit, &env, no_profile()).await,
        ],
        ["us-east-1", "ap-south-1"]
    );
}

#[tokio::test]
async fn takes_the_profile_region_when_the_environment_names_none() {
    let options = MakeAgentCoreWebSearchOptions::default();
    let profile: BoxFuture<'static, Option<String>> = Box::pin(async { Some("ca-central-1".to_owned()) });
    assert_eq!(
        resolve_region(&options, &env(&[("AWS_DEFAULT_REGION", "")]), profile).await,
        "ca-central-1"
    );
    assert_eq!(
        resolve_region(&options, &env(&[("AWS_DEFAULT_REGION", "sa-east-1")]), no_profile()).await,
        "sa-east-1"
    );
}

#[tokio::test]
async fn passes_other_service_errors_through_including_a_modeled_404_and_keeps_calling() {
    let harnessed = scripted(
        "us-east-1",
        vec![
            Err(CallFailure::Other("slow down".to_owned())),
            Err(CallFailure::Other("no such web search".to_owned())),
        ],
    );
    assert_eq!(
        invoke(&harnessed.tool, json!({"query": "q"})).await,
        "web_search failed: slow down"
    );
    assert_eq!(
        invoke(&harnessed.tool, json!({"query": "q"})).await,
        "web_search failed: no such web search"
    );
}

#[test]
fn classifies_sdk_failures() {
    let denied = SdkError::service_error(
        InvokeWebSearchError::AccessDeniedException(
            AccessDeniedException::builder()
                .message("the request is not authorized")
                .build(),
        ),
        response(403),
    );
    assert_eq!(
        classify(&denied),
        CallFailure::AccessDenied("the request is not authorized".to_owned())
    );

    let modeled_not_found = SdkError::service_error(
        InvokeWebSearchError::ResourceNotFoundException(
            ResourceNotFoundException::builder()
                .message("no such web search")
                .build(),
        ),
        response(404),
    );
    assert_eq!(
        classify(&modeled_not_found),
        CallFailure::Other("no such web search".to_owned())
    );

    let routing_not_found = SdkError::service_error(InvokeWebSearchError::unhandled("Unexpected token"), response(404));
    assert!(matches!(classify(&routing_not_found), CallFailure::NotInRegion(_)));

    let throttled = SdkError::service_error(
        InvokeWebSearchError::ThrottlingException(ThrottlingException::builder().message("slow down").build()),
        response(429),
    );
    assert_eq!(classify(&throttled), CallFailure::Other("slow down".to_owned()));

    let no_credentials: SdkError<InvokeWebSearchError, HttpResponse> = SdkError::construction_failure(
        CredentialsError::not_loaded("no providers in chain provided credentials"),
    );
    let CallFailure::Credentials(reason) = classify(&no_credentials) else {
        panic!("expected a credentials failure");
    };
    assert!(
        reason.starts_with("the credential provider was not enabled"),
        "{reason}"
    );
    assert!(!reason.contains('\n'), "{reason}");
}
