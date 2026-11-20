//! Live Amazon Bedrock tests of the LLM human-in-the-loop classifier and `ClassifierStrategy`.
//! Ignored by default; they use the default AWS credential chain and skip when none resolve:
//!
//! ```text
//! cargo test -p strands --features bedrock --test live_interventions -- --ignored
//! ```

#![cfg(feature = "bedrock")]
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::print_stdout,
    reason = "live tests report failures by panicking and print skips"
)]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use aws_config::BehaviorVersion;
use aws_credential_types::provider::ProvideCredentials;
use serde_json::json;
use strands::models::bedrock::{BedrockModel, BedrockModelConfig};
use strands::models::routing::{
    ClassifierStrategy, ClassifierStrategyOptions, ModelRouter, ModelRouterOptions, RoutingCandidate,
    RoutingCandidateOptions,
};
use strands::tools::FunctionTool;
use strands::vended_interventions::hitl::{
    ClassifierConfig, HumanInTheLoop, HumanInTheLoopAsk, HumanInTheLoopConfig, LlmClassifierConfig,
};
use strands::{Agent, Model, StopReason};

const HAIKU: &str = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const NOVA_LITE: &str = "us.amazon.nova-lite-v1:0";
const NOVA_MICRO: &str = "us.amazon.nova-micro-v1:0";

async fn credentials_available() -> bool {
    let config = aws_config::load_defaults(BehaviorVersion::latest()).await;
    let Some(provider) = config.credentials_provider() else {
        println!("skipping: no AWS credentials provider");
        return false;
    };
    if provider.provide_credentials().await.is_err() {
        println!("skipping: AWS credentials did not resolve");
        return false;
    }
    true
}

fn model(model_id: &str, max_tokens: u64) -> Arc<dyn Model> {
    Arc::new(BedrockModel::new(BedrockModelConfig {
        model_id: Some(model_id.to_owned()),
        max_tokens: Some(max_tokens),
        ..BedrockModelConfig::default()
    }))
}

fn counted_tool(name: &str, description: &str, runs: &Arc<AtomicUsize>) -> FunctionTool {
    let runs = runs.clone();
    FunctionTool::builder(name, description)
        .input_schema(json!({"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}))
        .callback(move |_, _| {
            let runs = runs.clone();
            async move {
                runs.fetch_add(1, Ordering::SeqCst);
                Ok(json!("done"))
            }
        })
}

fn classified_agent(prompts: &Arc<Mutex<Vec<String>>>, runs: &Arc<AtomicUsize>) -> Agent {
    let prompts = prompts.clone();
    let hitl = HumanInTheLoop::new(HumanInTheLoopConfig {
        classifier: Some(ClassifierConfig::Llm(LlmClassifierConfig {
            model: Some(model(HAIKU, 512)),
            ..Default::default()
        })),
        ask: Some(HumanInTheLoopAsk::callback(move |prompt: String| {
            prompts.lock().unwrap().push(prompt);
            async { Ok(Some(json!("n"))) }
        })),
        ..Default::default()
    });
    Agent::builder()
        .model(model(HAIKU, 512))
        .tools([
            counted_tool("read_file", "Read a local temporary file", runs),
            counted_tool("delete_database", "Permanently delete a production database", runs),
        ])
        .interventions([hitl])
        .printer(false)
        .build()
        .unwrap()
}

#[tokio::test]
#[ignore = "calls Amazon Bedrock"]
async fn live_hitl_llm_classifier_lets_a_safe_call_run() {
    if !credentials_available().await {
        return;
    }
    let (prompts, runs) = (Arc::default(), Arc::default());
    let mut agent = classified_agent(&prompts, &runs);

    let result = agent
        .invoke("Call read_file once with path /tmp/notes.txt, then reply with one word.")
        .await
        .unwrap();

    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    assert!(prompts.lock().unwrap().is_empty(), "{:?}", prompts.lock().unwrap());
    assert_eq!(runs.load(Ordering::SeqCst), 1);
}

#[tokio::test]
#[ignore = "calls Amazon Bedrock"]
async fn live_hitl_llm_classifier_escalates_a_destructive_call() {
    if !credentials_available().await {
        return;
    }
    let (prompts, runs) = (Arc::default(), Arc::default());
    let mut agent = classified_agent(&prompts, &runs);

    agent
        .invoke("Call delete_database once with path prod/customers. Do not call any other tool.")
        .await
        .unwrap();

    let prompts = prompts.lock().unwrap();
    assert_eq!(prompts.len(), 1, "{prompts:?}");
    assert!(
        prompts[0].starts_with("Approve \"delete_database\" \u{2014} "),
        "{}",
        prompts[0]
    );
    println!("approval prompt: {}", prompts[0]);
    assert_eq!(runs.load(Ordering::SeqCst), 0);
}

fn candidate(model_id: &str, name: &str, description: &str) -> RoutingCandidate {
    RoutingCandidate::new(
        RoutingCandidateOptions::builder()
            .model(model(model_id, 4096))
            .name(name)
            .description(description)
            .build(),
    )
}

async fn routed_model_id(prompt: &str) -> Option<String> {
    let strategy = ClassifierStrategy::new(model(HAIKU, 256), ClassifierStrategyOptions::default()).unwrap();
    let router = ModelRouter::new(
        [
            candidate(
                NOVA_MICRO,
                "routine",
                "Fast model for short factual questions and greetings.",
            ),
            candidate(
                NOVA_LITE,
                "complex",
                "More capable model for multi-step reasoning, planning and long technical design work.",
            ),
        ],
        ModelRouterOptions {
            strategy: Some(Arc::new(strategy)),
            max_switches: None,
        },
    )
    .unwrap();
    let mut agent = Agent::builder().model(router).printer(false).build().unwrap();
    let models: Arc<Mutex<Vec<Option<String>>>> = Arc::default();
    let log = models.clone();
    agent.add_hook(move |event: &mut strands::AfterModelCallEvent<'_>| {
        log.lock().unwrap().push(event.model().model_id());
    });
    agent.invoke(prompt).await.unwrap();
    models.lock().unwrap().first().cloned().flatten()
}

#[tokio::test]
#[ignore = "calls Amazon Bedrock"]
async fn live_classifier_strategy_routes_by_request_complexity() {
    if !credentials_available().await {
        return;
    }
    let simple = routed_model_id("Hi! What is 2 + 2?").await;
    let complex = routed_model_id(
        "Design a zero-downtime migration plan for splitting a 4 TB Postgres monolith into three services, \
         covering dual writes, backfill verification, cutover sequencing and rollback at each step.",
    )
    .await;
    println!("simple -> {simple:?}, complex -> {complex:?}");
    assert_eq!(simple.as_deref(), Some(NOVA_MICRO));
    assert_eq!(complex.as_deref(), Some(NOVA_LITE));
}
