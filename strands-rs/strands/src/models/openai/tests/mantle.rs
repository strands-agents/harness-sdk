//! Mantle tests. Credentials come from a counting provider and the minted token is decoded, and
//! `token_matches_the_token_generator` checks the token against one the token generator's signer made.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, SystemTime};

use aws_credential_types::Credentials;
use aws_credential_types::provider::error::CredentialsError;
use aws_credential_types::provider::{ProvideCredentials, future};
use base64::Engine;

use super::super::mantle::{mint_token, resolve_mantle_base_path};
use super::*;

const TEST_MODEL_ID: &str = "openai.gpt-oss-120b";
const SECRET: &str = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";

/// Static test credentials that count how often they are asked for.
#[derive(Debug, Default)]
struct CountingCredentials {
    calls: AtomicUsize,
    fail: bool,
}

impl ProvideCredentials for CountingCredentials {
    fn provide_credentials<'a>(&'a self) -> future::ProvideCredentials<'a>
    where
        Self: 'a,
    {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.fail {
            return future::ProvideCredentials::ready(Err(CredentialsError::not_loaded("no credentials in chain")));
        }
        future::ProvideCredentials::ready(Ok(Credentials::new("AKIDEXAMPLE", SECRET, None, None, "test")))
    }
}

fn counting(fail: bool) -> (Arc<CountingCredentials>, SharedCredentialsProvider) {
    let credentials = Arc::new(CountingCredentials {
        calls: AtomicUsize::new(0),
        fail,
    });
    (
        Arc::clone(&credentials),
        SharedCredentialsProvider::new(SharedCounting(credentials)),
    )
}

#[derive(Debug)]
struct SharedCounting(Arc<CountingCredentials>);

impl ProvideCredentials for SharedCounting {
    fn provide_credentials<'a>(&'a self) -> future::ProvideCredentials<'a>
    where
        Self: 'a,
    {
        self.0.provide_credentials()
    }
}

fn mantle(region: Option<&str>) -> BedrockMantleConfig {
    BedrockMantleConfig {
        region: region.map(str::to_owned),
        credentials_provider: Some(counting(false).1),
        ..Default::default()
    }
}

fn mantle_options(api: OpenAIApi, model_id: &str) -> OpenAIModelOptions {
    OpenAIModelOptions {
        model_id: Some(model_id.to_owned()),
        ..options(api)
    }
}

fn build_with_env(
    options: OpenAIModelOptions,
    mantle_config: BedrockMantleConfig,
    vars: &[(&str, &str)],
) -> Result<OpenAIModel> {
    constructing(|| OpenAIModel::bedrock_mantle_with_env(options, mantle_config, &env_of(vars)))
}

fn mantle_model(api: OpenAIApi, model_id: &str, mantle_config: BedrockMantleConfig) -> OpenAIModel {
    build_with_env(mantle_options(api, model_id), mantle_config, &[]).unwrap()
}

fn base_url(model: &OpenAIModel) -> String {
    model.inner.mantle.as_ref().unwrap().read().unwrap().base_url.clone()
}

fn route_api_key(model: &OpenAIModel) -> ApiKey {
    model.inner.mantle.as_ref().unwrap().read().unwrap().api_key.clone()
}

async fn mint(model: &OpenAIModel) -> std::result::Result<String, BoxError> {
    let ApiKey::Setter(setter) = route_api_key(model) else {
        panic!("the Mantle api key is a function");
    };
    setter().await
}

/// The presigned URL inside a bearer token.
fn presigned_url(token: &str) -> String {
    let encoded = token.strip_prefix("bedrock-api-key-").unwrap();
    String::from_utf8(base64::engine::general_purpose::STANDARD.decode(encoded).unwrap()).unwrap()
}

mod constructor_wiring {
    use super::*;

    #[tokio::test]
    async fn sets_base_url_and_installs_async_api_key_setter_that_mints_a_bearer_token() {
        let model = mantle_model(OpenAIApi::Responses, TEST_MODEL_ID, mantle(Some("us-east-1")));
        assert_eq!(base_url(&model), "https://bedrock-mantle.us-east-1.api.aws/v1");
        let url = presigned_url(&mint(&model).await.unwrap());
        assert!(url.starts_with("bedrock.amazonaws.com/?Action=CallWithBearerToken&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIDEXAMPLE%2F"), "{url}");
        assert!(url.contains("%2Fus-east-1%2Fbedrock%2Faws4_request"), "{url}");
        assert!(url.contains("&X-Amz-Expires=43200&"), "{url}");
        assert!(url.ends_with("&X-Amz-SignedHeaders=host&Version=1"), "{url}");
    }

    #[tokio::test]
    async fn forwards_optional_credentials_and_expires_in_seconds_to_the_token_provider() {
        let (credentials, provider) = counting(false);
        let config = BedrockMantleConfig {
            region: Some("us-west-2".to_owned()),
            credentials_provider: Some(provider),
            expires_in: Some(Duration::from_secs(900)),
        };
        let model = mantle_model(OpenAIApi::Responses, TEST_MODEL_ID, config);
        let url = presigned_url(&mint(&model).await.unwrap());
        assert!(url.contains("%2Fus-west-2%2Fbedrock%2Faws4_request"), "{url}");
        assert!(url.contains("&X-Amz-Expires=900&"), "{url}");
        assert_eq!(credentials.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn mints_a_fresh_token_on_every_api_key_setter_call() {
        let (credentials, provider) = counting(false);
        let config = BedrockMantleConfig {
            region: Some("us-east-1".to_owned()),
            credentials_provider: Some(provider),
            ..Default::default()
        };
        let model = mantle_model(OpenAIApi::Responses, TEST_MODEL_ID, config);
        for _ in 0..3 {
            assert!(mint(&model).await.unwrap().starts_with("bedrock-api-key-"));
        }
        // Credentials without an expiry are resolved once and reused; each call signs anew.
        assert_eq!(credentials.calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn merges_with_other_client_config_fields_while_overriding_base_url_and_api_key() {
        let client_config = OpenAIClientConfig {
            timeout: Some(Duration::from_millis(42)),
            default_headers: vec![("X-Trace-Id".to_owned(), "abc".to_owned())],
            ..Default::default()
        };
        let model = build_with_env(
            OpenAIModelOptions {
                client_config: Some(client_config.clone()),
                ..mantle_options(OpenAIApi::Responses, TEST_MODEL_ID)
            },
            mantle(Some("us-east-1")),
            &[],
        )
        .unwrap();
        let route = model.inner.mantle.as_ref().unwrap().read().unwrap();
        assert_eq!(route.client_config, client_config);
        assert_eq!(route.base_url, "https://bedrock-mantle.us-east-1.api.aws/v1");
    }

    #[test]
    fn does_not_check_openai_api_key_when_bedrock_mantle_config_is_set() {
        let options = mantle_options(OpenAIApi::Responses, TEST_MODEL_ID);
        assert!(build_with_env(options, mantle(Some("us-east-1")), &[("OPENAI_API_KEY", "")]).is_ok());
    }

    #[tokio::test]
    async fn mints_a_bearer_token_regardless_of_api_mode() {
        let model = mantle_model(OpenAIApi::Chat, TEST_MODEL_ID, mantle(Some("us-east-1")));
        assert!(mint(&model).await.unwrap().starts_with("bedrock-api-key-"));
    }

    #[test]
    fn token_matches_the_token_generator() {
        let time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_794_400_496);
        let credentials = Credentials::new("AKIDEXAMPLE", SECRET, None, None, "test");
        assert_eq!(
            mint_token(credentials, "us-east-1", 43_200, time).unwrap(),
            "bedrock-api-key-YmVkcm9jay5hbWF6b25hd3MuY29tLz9BY3Rpb249Q2FsbFdpdGhCZWFyZXJUb2tlbiZYLUFtei1BbGdvcml0aG09QVdTNC1ITUFDLVNIQTI1NiZYLUFtei1DcmVkZW50aWFsPUFLSURFWEFNUExFJTJGMjAyNjExMTElMkZ1cy1lYXN0LTElMkZiZWRyb2NrJTJGYXdzNF9yZXF1ZXN0JlgtQW16LURhdGU9MjAyNjExMTFUMTIzNDU2WiZYLUFtei1FeHBpcmVzPTQzMjAwJlgtQW16LVNpZ25hdHVyZT1iMTNjZTM3OTdlYjhhMjg3OTk0YmM2MGM1MmU4Zjg4MDQ5YjM4OTIzYWRhZjdlZjA1MGFiYjdmYWVkOWVjMDNjJlgtQW16LVNpZ25lZEhlYWRlcnM9aG9zdCZWZXJzaW9uPTE="
        );
        let with_session = Credentials::new(
            "AKIDEXAMPLE",
            SECRET,
            Some("session/token+with=chars".to_owned()),
            None,
            "test",
        );
        assert_eq!(
            presigned_url(&mint_token(with_session, "us-west-2", 900, time).unwrap()),
            "bedrock.amazonaws.com/?Action=CallWithBearerToken&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIDEXAMPLE%2F20261111%2Fus-west-2%2Fbedrock%2Faws4_request&X-Amz-Date=20261111T123456Z&X-Amz-Expires=900&X-Amz-Security-Token=session%2Ftoken%2Bwith%3Dchars&X-Amz-Signature=e0486b23da758c9d67cd5ec2b774c5404a793e69d3393b824178bdbcee6e4107&X-Amz-SignedHeaders=host&Version=1"
        );
    }

    #[tokio::test]
    async fn rejects_a_token_lifetime_outside_the_allowed_range() {
        for expires_in in [Duration::ZERO, Duration::from_secs(43_201)] {
            let config = BedrockMantleConfig {
                expires_in: Some(expires_in),
                ..mantle(Some("us-east-1"))
            };
            let model = mantle_model(OpenAIApi::Responses, TEST_MODEL_ID, config);
            let error = mint(&model).await.unwrap_err();
            assert_eq!(
                error.to_string(),
                "ExpiresInSeconds must be in the range (0, 43200] seconds."
            );
        }
    }
}

mod base_path_resolution_by_model_family {
    use super::*;

    fn base_url_for(api: OpenAIApi, model_id: &str) -> String {
        base_url(&mantle_model(api, model_id, mantle(Some("us-west-2"))))
    }

    #[test]
    fn uses_openai_v1_for_gpt_5_on_the_responses_and_chat_apis() {
        for api in [OpenAIApi::Responses, OpenAIApi::Chat] {
            assert_eq!(
                base_url_for(api, "openai.gpt-5.6-luna"),
                "https://bedrock-mantle.us-west-2.api.aws/openai/v1"
            );
        }
    }

    #[test]
    fn uses_v1_for_gpt_oss_on_the_responses_and_chat_apis() {
        for api in [OpenAIApi::Responses, OpenAIApi::Chat] {
            assert_eq!(
                base_url_for(api, "openai.gpt-oss-120b"),
                "https://bedrock-mantle.us-west-2.api.aws/v1"
            );
        }
    }

    #[test]
    fn matches_only_bedrock_style_ids() {
        assert_eq!(
            base_url_for(OpenAIApi::Responses, "gpt-5.4"),
            "https://bedrock-mantle.us-west-2.api.aws/v1"
        );
    }

    #[test]
    fn routes_model_ids_on_both_api_surfaces() {
        let cases = [
            ("xai.grok-4.3", "/openai/v1"),
            ("google.gemma-4-31b", "/openai/v1"),
            ("google.gemma-4-26b-a4b", "/openai/v1"),
            ("google.gemma-4-e2b", "/openai/v1"),
            ("openai.gpt-5.6-terra", "/openai/v1"),
            ("openai.gpt-5.6-cyber", "/openai/v1"),
            ("openai.gpt-daybreak-blue-5.6-sol", "/openai/v1"),
            ("openai.gpt-6-astra", "/openai/v1"),
            ("openai.gpt-6.1-sol", "/openai/v1"),
            ("google.gemma-3-27b-it", "/v1"),
            ("google.gemma-3-4b-it", "/v1"),
            ("openai.gpt-oss-120b", "/v1"),
            ("openai.gpt-oss-safeguard-20b", "/v1"),
            ("qwen.qwen3-32b", "/v1"),
            ("deepseek.v3.2", "/v1"),
            ("mistral.ministral-3-8b-instruct", "/v1"),
            ("zai.glm-5", "/v1"),
            ("moonshotai.kimi-k2.5", "/v1"),
            ("minimax.minimax-m2", "/v1"),
            ("nvidia.nemotron-nano-9b-v2", "/v1"),
            ("writer.palmyra-vision-7b", "/v1"),
        ];
        for (model_id, expected) in cases {
            let url = format!("https://bedrock-mantle.us-west-2.api.aws{expected}");
            assert_eq!(base_url_for(OpenAIApi::Responses, model_id), url, "{model_id}");
            assert_eq!(base_url_for(OpenAIApi::Chat, model_id), url, "{model_id}");
        }
    }

    #[test]
    fn resolves_unverified_model_ids() {
        let cases = [
            ("xai.grok-4.9", "/openai/v1"),
            ("openai.gpt-5.9-unreleased", "/openai/v1"),
            ("openai.gpt-6-nova", "/openai/v1"),
            ("openai.gpt-6.1-sol", "/openai/v1"),
            ("xai.grok-5", "/v1"),
            ("xai.grok-5-preview", "/v1"),
            ("openai.gpt-6oss-20b", "/v1"),
        ];
        for (model_id, expected) in cases {
            assert_eq!(resolve_mantle_base_path(model_id), expected, "{model_id}");
        }
    }

    fn client_of(model: &OpenAIModel) -> Arc<dyn OpenAIClient> {
        model.inner.client()
    }

    #[test]
    fn reroutes_the_mantle_base_url_when_update_config_moves_model_id_across_base_paths() {
        let model = mantle_model(OpenAIApi::Responses, "openai.gpt-oss-120b", mantle(Some("us-west-2")));
        assert_eq!(base_url(&model), "https://bedrock-mantle.us-west-2.api.aws/v1");
        let before = client_of(&model);
        model
            .update_config(OpenAIModelConfig::builder().model_id("xai.grok-4.3").build())
            .unwrap();
        assert_eq!(model.config().model_id.as_deref(), Some("xai.grok-4.3"));
        assert!(!Arc::ptr_eq(&before, &client_of(&model)));
        assert_eq!(base_url(&model), "https://bedrock-mantle.us-west-2.api.aws/openai/v1");
    }

    #[test]
    fn reuses_the_construction_time_api_key_setter_when_rerouting() {
        let model = mantle_model(OpenAIApi::Responses, "openai.gpt-oss-120b", mantle(Some("us-west-2")));
        let original = route_api_key(&model);
        model
            .update_config(OpenAIModelConfig::builder().model_id("xai.grok-4.3").build())
            .unwrap();
        assert_eq!(route_api_key(&model), original);
    }

    #[test]
    fn keeps_the_existing_client_when_the_new_model_id_stays_on_the_same_base_path() {
        let model = mantle_model(OpenAIApi::Responses, "openai.gpt-oss-120b", mantle(Some("us-west-2")));
        let before = client_of(&model);
        model
            .update_config(OpenAIModelConfig::builder().model_id("qwen.qwen3-32b").build())
            .unwrap();
        assert_eq!(model.config().model_id.as_deref(), Some("qwen.qwen3-32b"));
        assert!(Arc::ptr_eq(&before, &client_of(&model)));
        assert_eq!(base_url(&model), "https://bedrock-mantle.us-west-2.api.aws/v1");
    }

    #[test]
    fn keeps_the_existing_client_when_update_config_leaves_model_id_alone() {
        let model = mantle_model(OpenAIApi::Responses, "openai.gpt-oss-120b", mantle(Some("us-west-2")));
        let before = client_of(&model);
        let update = OpenAIModelConfig {
            params: Some(serde_json::json!({"temperature": 0.5})),
            ..Default::default()
        };
        model.update_config(update).unwrap();
        assert!(Arc::ptr_eq(&before, &client_of(&model)));
    }

    #[test]
    fn does_not_touch_the_client_when_bedrock_mantle_config_is_not_used() {
        let model = chat_model(&idle());
        let before = client_of(&model);
        model
            .update_config(OpenAIModelConfig::builder().model_id("openai.gpt-oss-120b").build())
            .unwrap();
        assert!(Arc::ptr_eq(&before, &client_of(&model)));
    }
}

mod validation {
    use super::*;

    #[test]
    fn throws_when_client_config_base_url_is_set_alongside_bedrock_mantle_config() {
        let options = OpenAIModelOptions {
            client_config: Some(
                OpenAIClientConfig::builder()
                    .base_url("https://example.invalid")
                    .build(),
            ),
            ..mantle_options(OpenAIApi::Responses, TEST_MODEL_ID)
        };
        let error = build_with_env(options, mantle(Some("us-east-1")), &[]).unwrap_err();
        assert_eq!(
            error.to_string(),
            "client_config must not contain base_url for Bedrock Mantle; it is derived from the Mantle config automatically."
        );
    }

    #[test]
    fn throws_when_top_level_api_key_is_set_alongside_bedrock_mantle_config() {
        let options = OpenAIModelOptions {
            api_key: Some("sk-nope".into()),
            ..mantle_options(OpenAIApi::Responses, TEST_MODEL_ID)
        };
        let error = build_with_env(options, mantle(Some("us-east-1")), &[]).unwrap_err();
        assert_eq!(
            error.to_string(),
            "'api_key' cannot be combined with Bedrock Mantle; the API key is derived from the Mantle config automatically."
        );
    }
}

mod region_resolution {
    use super::*;

    fn route_region(vars: &[(&str, &str)], region: Option<&str>) -> Result<String> {
        let model = build_with_env(
            mantle_options(OpenAIApi::Responses, TEST_MODEL_ID),
            mantle(region),
            vars,
        )?;
        Ok(model.inner.mantle.as_ref().unwrap().read().unwrap().region.clone())
    }

    #[test]
    fn throws_when_no_region_is_available_from_config_or_env() {
        let error = route_region(&[("AWS_REGION", ""), ("AWS_DEFAULT_REGION", "")], None).unwrap_err();
        assert_eq!(
            error.to_string(),
            "could not resolve an AWS region for Bedrock Mantle. Pass 'region' in BedrockMantleConfig or set AWS_REGION in the environment. See https://docs.aws.amazon.com/bedrock/latest/userguide/inference-openai.html for supported regions."
        );
    }

    #[test]
    fn falls_back_to_aws_region_env_var() {
        assert_eq!(route_region(&[("AWS_REGION", "eu-west-1")], None).unwrap(), "eu-west-1");
        let model = build_with_env(
            mantle_options(OpenAIApi::Responses, TEST_MODEL_ID),
            mantle(None),
            &[("AWS_REGION", "eu-west-1")],
        )
        .unwrap();
        assert_eq!(base_url(&model), "https://bedrock-mantle.eu-west-1.api.aws/v1");
    }

    #[test]
    fn falls_back_to_aws_default_region_when_aws_region_is_unset() {
        assert_eq!(
            route_region(&[("AWS_REGION", ""), ("AWS_DEFAULT_REGION", "ap-southeast-2")], None).unwrap(),
            "ap-southeast-2"
        );
    }

    #[test]
    fn prefers_explicit_region_over_env_vars() {
        assert_eq!(
            route_region(&[("AWS_REGION", "eu-west-1")], Some("us-east-1")).unwrap(),
            "us-east-1"
        );
    }

    #[test]
    fn rejects_a_malformed_region_before_building_the_endpoint_url() {
        for region in [
            "x@attacker.com/",
            "us-east-1\n",
            "us-east-1/",
            "US-EAST-1",
            "useast1",
            "us-east-١",
            "us-éast-1",
        ] {
            let (credentials, provider) = counting(false);
            let config = BedrockMantleConfig {
                region: Some(region.to_owned()),
                credentials_provider: Some(provider),
                ..Default::default()
            };
            let error = build_with_env(mantle_options(OpenAIApi::Responses, TEST_MODEL_ID), config, &[]).unwrap_err();
            assert_eq!(error.to_string(), format!("invalid AWS region: '{region}'"));
            assert_eq!(credentials.calls.load(Ordering::SeqCst), 0);
        }
    }

    #[test]
    fn accepts_the_well_formed_region() {
        for region in ["us-east-1", "ap-southeast-1", "us-gov-east-1"] {
            assert_eq!(route_region(&[], Some(region)).unwrap(), region);
        }
    }

    #[test]
    fn rejects_a_malformed_region_supplied_via_aws_region() {
        let error = route_region(&[("AWS_REGION", "x@attacker.com/")], None).unwrap_err();
        assert!(error.to_string().contains("invalid AWS region"), "{error}");
    }
}

mod token_minting_errors {
    use super::*;

    #[tokio::test]
    async fn wraps_token_provider_failures_with_actionable_context() {
        let config = BedrockMantleConfig {
            region: Some("us-east-1".to_owned()),
            credentials_provider: Some(counting(true).1),
            ..Default::default()
        };
        let model = mantle_model(OpenAIApi::Responses, TEST_MODEL_ID, config);
        let error = mint(&model).await.unwrap_err();
        assert_eq!(
            error.to_string(),
            "failed to mint Bedrock Mantle bearer token for region 'us-east-1' | verify your AWS credentials and network connectivity"
        );
        assert!(std::error::Error::source(error.as_ref()).is_some());
    }
}
