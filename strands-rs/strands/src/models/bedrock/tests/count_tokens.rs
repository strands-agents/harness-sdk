//! Token counting tests. Skipped model ids are remembered process-wide, so each test uses
//! its own model id.

use serde_json::json;

use super::*;
use crate::models::CountTokensOptions;

fn native(model_id: &str) -> BedrockModelConfig {
    BedrockModelConfig {
        use_native_token_count: Some(true),
        ..with_model_id(model_id)
    }
}

fn messages() -> Vec<Message> {
    vec![Message::user("hello")]
}

fn test_tool() -> ToolSpec {
    ToolSpec::new("test_tool", "A test tool").with_input_schema(json!({"type": "object", "properties": {}}))
}

fn count_inputs(transport: &MockTransport) -> Vec<JsonValue> {
    transport
        .count_calls
        .lock()
        .unwrap()
        .iter()
        .map(|(_, input)| json!({"converse": input}))
        .collect()
}

#[tokio::test]
async fn should_use_heuristic_by_default_when_use_native_token_count_is_not_set() {
    let (model, transport) = provider(BedrockModelConfig::default());
    assert_eq!(
        model
            .count_tokens(&messages(), CountTokensOptions::default())
            .await
            .unwrap(),
        2
    );
    assert!(transport.count_calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn should_return_native_token_count_on_success() {
    let (model, transport) = provider(native("count.success"));
    transport.push_count(Ok(Some(42)));
    assert_eq!(
        model
            .count_tokens(&messages(), CountTokensOptions::default())
            .await
            .unwrap(),
        42
    );
    assert_eq!(transport.count_calls.lock().unwrap().len(), 1);
    assert_eq!(transport.count_calls.lock().unwrap()[0].0, "count.success");
}

#[tokio::test]
async fn should_include_system_prompt_in_request() {
    let (model, transport) = provider(native("count.system"));
    transport.push_count(Ok(Some(55)));
    let options = CountTokensOptions {
        system_prompt: Some("Be helpful.".into()),
        ..CountTokensOptions::default()
    };
    assert_eq!(model.count_tokens(&messages(), options).await.unwrap(), 55);
    assert_eq!(
        count_inputs(&transport),
        [json!({"converse": {
            "messages": [{"role": "user", "content": [{"text": "hello"}]}],
            "system": [{"text": "Be helpful."}]
        }})]
    );
}

#[tokio::test]
async fn should_include_tool_specs_in_request() {
    let (model, transport) = provider(native("count.tools"));
    transport.push_count(Ok(Some(100)));
    let options = CountTokensOptions {
        tool_specs: vec![test_tool()],
        ..CountTokensOptions::default()
    };
    assert_eq!(model.count_tokens(&messages(), options).await.unwrap(), 100);
    assert_eq!(
        count_inputs(&transport),
        [json!({"converse": {
            "messages": [{"role": "user", "content": [{"text": "hello"}]}],
            "toolConfig": {"tools": [{"toolSpec": {
                "name": "test_tool",
                "description": "A test tool",
                "inputSchema": {"json": {"type": "object", "properties": {}}}
            }}]}
        }})]
    );
}

#[tokio::test]
async fn should_strip_inference_config_from_request() {
    let (model, transport) = provider(BedrockModelConfig {
        max_tokens: Some(100),
        ..native("count.strip")
    });
    transport.push_count(Ok(Some(10)));
    model
        .count_tokens(&messages(), CountTokensOptions::default())
        .await
        .unwrap();
    assert_eq!(
        count_inputs(&transport),
        [json!({"converse": {"messages": [{"role": "user", "content": [{"text": "hello"}]}]}})]
    );
}

#[tokio::test]
async fn should_fall_back_to_estimation_on_api_error() {
    let (model, transport) = provider(native("count.api-error"));
    transport.push_count(Err(plain_error("API error")));
    assert_eq!(
        model
            .count_tokens(&messages(), CountTokensOptions::default())
            .await
            .unwrap(),
        2
    );
}

#[tokio::test]
async fn should_fall_back_to_estimation_on_generic_exception() {
    let (model, transport) = provider(native("count.generic"));
    transport.push_count(Err(BedrockError::network("Connection failed")));
    assert_eq!(
        model
            .count_tokens(&messages(), CountTokensOptions::default())
            .await
            .unwrap(),
        2
    );
}

#[tokio::test]
async fn falls_back_to_estimation_when_the_count_is_missing() {
    let (model, transport) = provider(native("count.missing"));
    transport.push_count(Ok(None));
    assert_eq!(
        model
            .count_tokens(&messages(), CountTokensOptions::default())
            .await
            .unwrap(),
        2
    );
}

async fn second_call_skipped(model_id: &str, error: BedrockError) -> usize {
    let (model, transport) = provider(native(model_id));
    transport.push_count(Err(error));
    model
        .count_tokens(&messages(), CountTokensOptions::default())
        .await
        .unwrap();
    assert_eq!(transport.count_calls.lock().unwrap().len(), 1);
    model
        .count_tokens(&messages(), CountTokensOptions::default())
        .await
        .unwrap();
    transport.count_calls.lock().unwrap().len()
}

#[tokio::test]
async fn should_cache_model_id_and_skip_api_call_when_model_does_not_support_counting_tokens() {
    let error = validation("The provided model doesn't support counting tokens");
    assert_eq!(second_call_skipped("count.unsupported", error).await, 1);
}

#[tokio::test]
async fn should_cache_model_id_and_skip_api_call_on_access_denied_exception() {
    let error = service_error(
        "AccessDeniedException",
        "User: arn:aws:sts::123456789012:assumed-role/role is not authorized to perform: bedrock:CountTokens",
    );
    assert_eq!(second_call_skipped("count.denied", error).await, 1);
}

#[tokio::test]
async fn should_not_cache_model_id_for_other_errors() {
    assert_eq!(
        second_call_skipped("count.transient", plain_error("Transient network error")).await,
        2
    );
}

#[tokio::test]
async fn should_skip_native_api_and_use_heuristic_when_use_native_token_count_is_false() {
    let (model, transport) = provider(BedrockModelConfig {
        use_native_token_count: Some(false),
        ..BedrockModelConfig::default()
    });
    assert_eq!(
        model
            .count_tokens(&messages(), CountTokensOptions::default())
            .await
            .unwrap(),
        2
    );
    assert!(transport.count_calls.lock().unwrap().is_empty());
}
