//! Routing an [`OpenAIModel`](super::OpenAIModel) through Amazon Bedrock's OpenAI-compatible
//! "Mantle" endpoint, behind the `mantle` feature.
//!
//! [`OpenAIModel::bedrock_mantle`] takes a [`BedrockMantleConfig`], which gives the client its base URL and an API key function that mints a
//! fresh bearer token for every request, so long-running agents outlive a token's lifetime. The
//! token is the one `@aws/bedrock-token-generator` makes: `bedrock-api-key-` and the base64 of a
//! SigV4-presigned `CallWithBearerToken` URL, signed with credentials from the provider in the
//! config or the default AWS credential chain.

use std::fmt;
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use std::time::{Duration, SystemTime};

use aws_config::Region;
use aws_config::default_provider::credentials::DefaultCredentialsChain;
use aws_credential_types::Credentials;
use aws_credential_types::provider::{ProvideCredentials, SharedCredentialsProvider};
use aws_sigv4::http_request::{SignableBody, SignableRequest, SignatureLocation, SigningSettings, sign};
use aws_sigv4::sign::v4;
use base64::Engine;
use tokio::sync::OnceCell;

use super::client::{Env, HttpOpenAIClient};
use super::{
    ApiKey, Inner, OpenAIClientConfig, OpenAIModel, OpenAIModelOptions, model_error, model_id_of, prepare_config,
};
use crate::error::{BoxError, Error, Result};

const MANTLE_DOCS_URL: &str = "https://docs.aws.amazon.com/bedrock/latest/userguide/inference-openai.html";

/// Mantle model lines served from `/openai/v1`; every other model uses `/v1`, and the wrong base
/// path fails with HTTP 400. No Mantle API reports a model's base path, so these prefixes follow
/// the verified `us-east-1` catalog. Each prefix covers one model line, never a vendor: one
/// vendor's lines can split across base paths (`google.gemma-4-*` is on `/openai/v1`,
/// `google.gemma-3-*` on `/v1`).
const OPENAI_PATH_MODEL_PREFIXES: [&str; 6] = [
    "openai.gpt-5.",
    "openai.gpt-daybreak-",
    "openai.gpt-6-",
    "openai.gpt-6.",
    "xai.grok-4.",
    "google.gemma-4-",
];

const MAX_TOKEN_EXPIRES_IN_SECONDS: u64 = 43_200;
const SERVICE_NAME: &str = "bedrock";
const TOKEN_HOST: &str = "bedrock.amazonaws.com";
const TOKEN_ACTION: &str = "CallWithBearerToken";
const AUTH_PREFIX: &str = "bedrock-api-key-";
const TOKEN_VERSION: &str = "&Version=1";

/// Credentials within this window of their expiry are fetched again, as the AWS SDKs refresh them.
const CREDENTIALS_REFRESH_WINDOW: Duration = Duration::from_secs(300);

/// Routes an `OpenAIModel` through Amazon Bedrock's Mantle endpoint (`BedrockMantleConfig`).
///
/// Passed to [`OpenAIModel::bedrock_mantle`], which sets the client's base URL and API key from
/// it.
#[derive(Clone, Default, bon::Builder)]
pub struct BedrockMantleConfig {
    /// AWS region of the Mantle endpoint. Defaults to `AWS_REGION`, else `AWS_DEFAULT_REGION`;
    /// building the model fails when none is set.
    #[builder(into)]
    pub region: Option<String>,
    /// Credentials the bearer tokens are signed with, replacing the default AWS credential chain.
    /// This AWS SDK type is part of the public API as an escape hatch; wrap static
    /// [`Credentials`](super::Credentials) with [`SharedCredentialsProvider::new`].
    pub credentials_provider: Option<SharedCredentialsProvider>,
    /// Bearer token lifetime, at most 12 hours, which is also the default.
    pub expires_in: Option<Duration>,
}

impl fmt::Debug for BedrockMantleConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BedrockMantleConfig")
            .field("region", &self.region)
            .field(
                "credentials_provider",
                &self.credentials_provider.as_ref().map(|_| "<set>"),
            )
            .field("expires_in", &self.expires_in)
            .finish()
    }
}

/// Whether `region` looks like an AWS region (`/^[a-z]{2}(-[a-z]+)+-[0-9]+$/`), such as
/// `us-east-1` or `us-gov-east-1`.
fn is_valid_region(region: &str) -> bool {
    let parts: Vec<&str> = region.split('-').collect();
    let [first, middle @ .., last] = parts.as_slice() else {
        return false;
    };
    let letters = |part: &&str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_lowercase());
    first.len() == 2
        && letters(first)
        && !middle.is_empty()
        && middle.iter().all(letters)
        && !last.is_empty()
        && last.bytes().all(|byte| byte.is_ascii_digit())
}

/// Validates a region before it goes into the endpoint URL, where a malformed one (with `@`, `:`,
/// `/` or `#`) could point the request, and its bearer token, at another host.
fn validate_region(region: &str) -> Result<String> {
    if !is_valid_region(region) {
        return Err(Error::other(format!("invalid AWS region: '{region}'")));
    }
    Ok(region.to_owned())
}

/// The Mantle region: the config's, else `AWS_REGION`, else
/// `AWS_DEFAULT_REGION`, validated.
pub(super) fn resolve_mantle_region(config: &BedrockMantleConfig, env: Env<'_>) -> Result<String> {
    if let Some(region) = config.region.as_deref().filter(|region| !region.is_empty()) {
        return validate_region(region);
    }
    let from_env = env("AWS_REGION")
        .filter(|region| !region.is_empty())
        .or_else(|| env("AWS_DEFAULT_REGION").filter(|region| !region.is_empty()));
    if let Some(region) = from_env {
        return validate_region(&region);
    }
    Err(Error::other(format!(
        "could not resolve an AWS region for Bedrock Mantle. Pass 'region' in BedrockMantleConfig or set AWS_REGION in the environment. See {MANTLE_DOCS_URL} for supported regions."
    )))
}

/// The Mantle base path of a model.
pub(super) fn resolve_mantle_base_path(model_id: &str) -> &'static str {
    if OPENAI_PATH_MODEL_PREFIXES
        .iter()
        .any(|prefix| model_id.starts_with(prefix))
    {
        "/openai/v1"
    } else {
        "/v1"
    }
}

/// The Mantle base URL for a region and model.
pub(super) fn bedrock_mantle_base_url(region: &str, model_id: &str) -> String {
    format!(
        "https://bedrock-mantle.{region}.api.aws{}",
        resolve_mantle_base_path(model_id)
    )
}

/// The token lifetime in seconds, checked as the token generator checks it.
fn token_expires_in_seconds(expires_in: Option<Duration>) -> Result<u64, BoxError> {
    let Some(expires_in) = expires_in else {
        return Ok(MAX_TOKEN_EXPIRES_IN_SECONDS);
    };
    let seconds = expires_in.as_secs();
    if seconds == 0 || seconds > MAX_TOKEN_EXPIRES_IN_SECONDS {
        return Err(
            format!("ExpiresInSeconds must be in the range (0, {MAX_TOKEN_EXPIRES_IN_SECONDS}] seconds.").into(),
        );
    }
    Ok(seconds)
}

/// Percent-encodes every byte except ASCII letters, digits and `-_.~`, as the AWS SDK's URI escaping
/// does.
fn escape_uri(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            escaped.push(char::from(byte));
        } else {
            escaped.push_str(&format!("%{byte:02X}"));
        }
    }
    escaped
}

/// Mints a bearer token: presigns `POST https://bedrock.amazonaws.com/?Action=CallWithBearerToken` for
/// `bedrock` in `region`, drops the scheme, appends `&Version=1` and base64-encodes it after
/// `bedrock-api-key-`.
pub(super) fn mint_token(
    credentials: Credentials,
    region: &str,
    expires_in_seconds: u64,
    time: SystemTime,
) -> Result<String, BoxError> {
    let identity = credentials.into();
    let mut settings = SigningSettings::default();
    settings.signature_location = SignatureLocation::QueryParams;
    settings.expires_in = Some(Duration::from_secs(expires_in_seconds));
    let params = v4::SigningParams::builder()
        .identity(&identity)
        .region(region)
        .name(SERVICE_NAME)
        .time(time)
        .settings(settings)
        .build()?
        .into();
    let url = format!("https://{TOKEN_HOST}/?Action={TOKEN_ACTION}");
    let request = SignableRequest::new(
        "POST",
        url,
        std::iter::once(("host", TOKEN_HOST)),
        SignableBody::Bytes(&[]),
    )?;
    let (instructions, _signature) = sign(request, &params)?.into_parts();
    let mut query: Vec<(&str, String)> = vec![("Action", TOKEN_ACTION.to_owned())];
    query.extend(
        instructions
            .params()
            .iter()
            .map(|(name, value)| (*name, value.to_string())),
    );
    // The token generator's URL formatter writes the query sorted by key.
    query.sort_by(|left, right| left.0.cmp(right.0));
    let query = query
        .iter()
        .map(|(name, value)| format!("{}={}", escape_uri(name), escape_uri(value)))
        .collect::<Vec<_>>()
        .join("&");
    let presigned = format!("{TOKEN_HOST}/?{query}{TOKEN_VERSION}");
    Ok(format!(
        "{AUTH_PREFIX}{}",
        base64::engine::general_purpose::STANDARD.encode(presigned)
    ))
}

/// Mints Mantle bearer tokens with the configured or default credentials. The default chain is built
/// once, on the first token.
pub(super) struct MantleTokenProvider {
    region: String,
    configured: Option<SharedCredentialsProvider>,
    expires_in: Option<Duration>,
    default_chain: OnceCell<SharedCredentialsProvider>,
    cached: Mutex<Option<Credentials>>,
}

impl MantleTokenProvider {
    pub(super) fn new(config: BedrockMantleConfig, region: &str) -> Self {
        Self {
            region: region.to_owned(),
            configured: config.credentials_provider,
            expires_in: config.expires_in,
            default_chain: OnceCell::new(),
            cached: Mutex::new(None),
        }
    }

    async fn provider(&self) -> &SharedCredentialsProvider {
        if let Some(provider) = &self.configured {
            return provider;
        }
        self.default_chain
            .get_or_init(|| async {
                let chain = DefaultCredentialsChain::builder()
                    .region(Region::new(self.region.clone()))
                    .build()
                    .await;
                SharedCredentialsProvider::new(chain)
            })
            .await
    }

    /// The credentials, reused until they come within the refresh window of their expiry.
    async fn credentials(&self) -> Result<Credentials, BoxError> {
        let fresh = |credentials: &Credentials| {
            credentials.expiry().is_none_or(|expiry| {
                expiry
                    .duration_since(SystemTime::now())
                    .is_ok_and(|left| left > CREDENTIALS_REFRESH_WINDOW)
            })
        };
        let cached = self.cached.lock().unwrap_or_else(PoisonError::into_inner).clone();
        if let Some(credentials) = cached.filter(fresh) {
            return Ok(credentials);
        }
        let credentials = self.provider().await.provide_credentials().await?;
        *self.cached.lock().unwrap_or_else(PoisonError::into_inner) = Some(credentials.clone());
        Ok(credentials)
    }

    /// Mints a token.
    async fn token(&self) -> Result<String, BoxError> {
        let credentials = self.credentials().await?;
        mint_token(
            credentials,
            &self.region,
            token_expires_in_seconds(self.expires_in)?,
            SystemTime::now(),
        )
    }
}

/// An API key function that mints a fresh bearer token on every call,
/// with an actionable message when minting fails. An out-of-range `expires_in` is reported as is.
pub(super) fn mantle_api_key(provider: Arc<MantleTokenProvider>) -> ApiKey {
    ApiKey::setter(move || {
        let provider = Arc::clone(&provider);
        async move {
            token_expires_in_seconds(provider.expires_in)?;
            provider.token().await.map_err(|cause| {
                let message = format!(
                    "failed to mint Bedrock Mantle bearer token for region '{}' | verify your AWS credentials and network connectivity",
                    provider.region
                );
                BoxError::from(MantleTokenError { message, source: cause })
            })
        }
    })
}

/// A bearer token could not be minted.
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
struct MantleTokenError {
    message: String,
    #[source]
    source: BoxError,
}

impl OpenAIModel {
    /// Creates a model that routes through Amazon Bedrock's OpenAI-compatible Mantle endpoint.
    ///
    /// The base URL follows the region and the model's base path, and the API key mints a fresh
    /// SigV4 bearer token for every request.
    ///
    /// ```no_run
    /// use strands::models::openai::{BedrockMantleConfig, OpenAIModel, OpenAIModelOptions};
    ///
    /// # fn main() -> strands::Result<()> {
    /// let model = OpenAIModel::bedrock_mantle(
    ///     OpenAIModelOptions::builder().model_id("openai.gpt-oss-120b").build_options(),
    ///     BedrockMantleConfig::builder().region("us-east-1").build(),
    /// )?;
    /// # Ok(())
    /// # }
    /// ```
    ///
    /// # Errors
    ///
    /// Fails when `options` sets `api_key` or `client_config.base_url`, which the Mantle config
    /// sets instead, when the region is missing or malformed, when `params` is not a JSON object,
    /// or when the HTTP client cannot be built.
    pub fn bedrock_mantle(options: impl Into<OpenAIModelOptions>, mantle_config: BedrockMantleConfig) -> Result<Self> {
        Self::bedrock_mantle_with_env(options.into(), mantle_config, &|name| std::env::var(name).ok())
    }

    pub(super) fn bedrock_mantle_with_env(
        options: OpenAIModelOptions,
        mantle_config: BedrockMantleConfig,
        env: Env<'_>,
    ) -> Result<Self> {
        let parts = options.into_parts();
        let config = prepare_config(parts.api, parts.config)?;
        let route = MantleRoute::new(
            mantle_config,
            parts.api_key.as_ref(),
            parts.client_config,
            model_id_of(&config),
            env,
        )?;
        let client = route.client(env)?;
        Ok(Self::from_inner(Inner {
            api: parts.api,
            config: RwLock::new(config),
            client: RwLock::new(Arc::new(client)),
            mantle: Some(RwLock::new(route)),
        }))
    }
}

/// What a Mantle model keeps to rebuild its client when a model id change moves the base path.
pub(super) struct MantleRoute {
    pub(super) region: String,
    pub(super) client_config: OpenAIClientConfig,
    /// Built once and reused across reroutes: it holds the token provider and its credentials.
    pub(super) api_key: ApiKey,
    pub(super) base_url: String,
}

impl MantleRoute {
    fn new(
        mantle_config: BedrockMantleConfig,
        api_key: Option<&ApiKey>,
        client_config: OpenAIClientConfig,
        model_id: &str,
        env: Env<'_>,
    ) -> Result<Self> {
        if api_key.is_some() {
            return Err(Error::other(
                "'api_key' cannot be combined with Bedrock Mantle; the API key is derived from the Mantle config automatically.",
            ));
        }
        if client_config.base_url.is_some() {
            return Err(Error::other(
                "client_config must not contain base_url for Bedrock Mantle; it is derived from the Mantle config automatically.",
            ));
        }
        let region = resolve_mantle_region(&mantle_config, env)?;
        let base_url = bedrock_mantle_base_url(&region, model_id);
        let provider = Arc::new(MantleTokenProvider::new(mantle_config, &region));
        Ok(Self {
            api_key: mantle_api_key(provider),
            region,
            client_config,
            base_url,
        })
    }

    fn client(&self, env: Env<'_>) -> Result<HttpOpenAIClient> {
        HttpOpenAIClient::new(
            Some(&self.api_key),
            Some(self.base_url.clone()),
            &self.client_config,
            env,
        )
        .map_err(model_error)
    }
}

impl Inner {
    /// Points the Mantle client at the base path of `model_id` when it is the other one; a model
    /// on the same base path keeps the client and its connections.
    pub(super) fn reroute_mantle(&self, model_id: &str) -> Result<()> {
        let Some(mantle) = &self.mantle else {
            return Ok(());
        };
        let mut route = mantle.write().unwrap_or_else(PoisonError::into_inner);
        let next_base_url = bedrock_mantle_base_url(&route.region, model_id);
        if next_base_url == route.base_url {
            return Ok(());
        }
        tracing::debug!(
            "model_id=<{model_id}> | rerouting the Bedrock Mantle client from <{}> to <{next_base_url}>",
            route.base_url
        );
        let previous = std::mem::replace(&mut route.base_url, next_base_url);
        let client = match route.client(&|name| std::env::var(name).ok()) {
            Ok(client) => client,
            Err(error) => {
                route.base_url = previous;
                return Err(error);
            }
        };
        *self.client.write().unwrap_or_else(PoisonError::into_inner) = Arc::new(client);
        Ok(())
    }
}
