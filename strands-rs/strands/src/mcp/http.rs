//! The streamable HTTP transport a URL-configured client builds, with OAuth client credentials
//! ([`McpClientCredentials`]) or a token provider ([`McpAuthProvider`]).

use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::sync::Arc;

use async_trait::async_trait;
use futures::future::BoxFuture;
use futures::stream::BoxStream;
use reqwest::Url;
use reqwest::header::{HeaderName, HeaderValue};
use rmcp::model::ClientJsonRpcMessage;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::transport::auth::{AuthClient, AuthError, ClientCredentialsConfig, OAuthState};
use rmcp::transport::streamable_http_client::{
    StreamableHttpClient, StreamableHttpClientTransportConfig, StreamableHttpError, StreamableHttpPostResponse,
};
use serde::Deserialize;
use sse_stream::{Error as SseError, Sse};

use super::error::McpError;
use super::transport::{BoxedTransport, McpTransport};
use crate::error::BoxError;
use crate::types::JsonValue;

/// OAuth client credentials for machine-to-machine authentication (`McpClientCredentials`).
///
/// The client discovers the authorization server from the MCP server's protected resource
/// metadata and exchanges the credentials for a token on every connect, and again whenever the
/// server rejects the token or it expires.
///
/// Discovery refuses metadata that points at private addresses unless the server URL itself
/// names one of the same class (such as `localhost`); set
/// [`allow_private_addresses`](Self::allow_private_addresses) for an authorization server on a
/// private network. Link-local and other reserved addresses are always refused.
#[derive(Clone, Default, PartialEq, Eq, Deserialize, bon::Builder)]
#[serde(rename_all = "camelCase")]
#[builder(on(String, into))]
pub struct McpClientCredentials {
    /// The OAuth client id.
    pub client_id: String,
    /// The OAuth client secret.
    pub client_secret: String,
    /// The scopes to request.
    #[serde(default)]
    pub scopes: Option<Vec<String>>,
    /// Lets discovered metadata name hosts that resolve to private addresses
    /// (`allowPrivateAddresses`). Defaults to `false`.
    #[serde(default)]
    #[builder(default)]
    pub allow_private_addresses: bool,
}

impl fmt::Debug for McpClientCredentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("McpClientCredentials")
            .field("client_id", &self.client_id)
            .field("client_secret", &"<redacted>")
            .field("scopes", &self.scopes)
            .field("allow_private_addresses", &self.allow_private_addresses)
            .finish()
    }
}

/// Supplies the bearer token for each request of a URL-configured client (`authProvider`).
///
/// ```
/// use strands::mcp::McpAuthProvider;
///
/// struct StaticToken(String);
///
/// #[strands::async_trait]
/// impl McpAuthProvider for StaticToken {
///     async fn token(&self) -> Result<Option<String>, strands::BoxError> {
///         Ok(Some(self.0.clone()))
///     }
/// }
/// ```
#[async_trait]
pub trait McpAuthProvider: Send + Sync + 'static {
    /// The token to send as `Authorization: Bearer <token>`, or `None` to send none.
    async fn token(&self) -> Result<Option<String>, BoxError>;
}

#[derive(Clone)]
pub(crate) enum HttpAuth {
    None,
    Credentials(McpClientCredentials),
    Provider(Arc<dyn McpAuthProvider>),
}

#[derive(Clone)]
struct ProviderClient {
    inner: reqwest::Client,
    provider: Arc<dyn McpAuthProvider>,
}

type HttpResult<T> = Result<T, StreamableHttpError<reqwest::Error>>;

impl ProviderClient {
    async fn bearer(&self) -> HttpResult<Option<String>> {
        self.provider
            .token()
            .await
            .map_err(|error| StreamableHttpError::Auth(AuthError::InternalError(error.to_string())))
    }
}

impl StreamableHttpClient for ProviderClient {
    type Error = reqwest::Error;

    async fn post_message(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session_id: Option<Arc<str>>,
        _auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> HttpResult<StreamableHttpPostResponse> {
        let token = self.bearer().await?;
        self.inner
            .post_message(uri, message, session_id, token, custom_headers)
            .await
    }

    async fn post_message_with_max_sse_event_size(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session_id: Option<Arc<str>>,
        _auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
        max_sse_event_size: usize,
    ) -> HttpResult<StreamableHttpPostResponse> {
        let token = self.bearer().await?;
        self.inner
            .post_message_with_max_sse_event_size(uri, message, session_id, token, custom_headers, max_sse_event_size)
            .await
    }

    async fn delete_session(
        &self,
        uri: Arc<str>,
        session_id: Arc<str>,
        _auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> HttpResult<()> {
        let token = self.bearer().await?;
        self.inner.delete_session(uri, session_id, token, custom_headers).await
    }

    async fn get_stream(
        &self,
        uri: Arc<str>,
        session_id: Option<Arc<str>>,
        last_event_id: Option<String>,
        _auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> HttpResult<BoxStream<'static, Result<Sse, SseError>>> {
        let token = self.bearer().await?;
        self.inner
            .get_stream(uri, session_id, last_event_id, token, custom_headers)
            .await
    }

    async fn get_stream_with_max_sse_event_size(
        &self,
        uri: Arc<str>,
        session_id: Option<Arc<str>>,
        last_event_id: Option<String>,
        _auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
        max_sse_event_size: usize,
    ) -> HttpResult<BoxStream<'static, Result<Sse, SseError>>> {
        let token = self.bearer().await?;
        self.inner
            .get_stream_with_max_sse_event_size(
                uri,
                session_id,
                last_event_id,
                token,
                custom_headers,
                max_sse_event_size,
            )
            .await
    }
}

/// A client-credentials session that runs the grant again, and retries once, when the server
/// rejects the request for authorization: rmcp's `AuthClient` cannot refresh a client-credentials
/// token, so an expired token would otherwise fail every later request.
#[derive(Clone)]
struct CredentialsClient {
    auth: AuthClient<reqwest::Client>,
    config: Arc<ClientCredentialsConfig>,
}

fn needs_grant<E: std::error::Error + Send + Sync + 'static>(error: &StreamableHttpError<E>) -> bool {
    matches!(
        error,
        StreamableHttpError::AuthRequired(_) | StreamableHttpError::Auth(AuthError::AuthorizationRequired)
    )
}

impl CredentialsClient {
    async fn grant(&self) -> HttpResult<String> {
        tracing::debug!("requesting a new mcp access token");
        let token = self
            .auth
            .auth_manager
            .lock()
            .await
            .exchange_client_credentials(&self.config)
            .await?;
        serde_json::to_value(&token)?
            .get("access_token")
            .and_then(JsonValue::as_str)
            .map(str::to_owned)
            .ok_or_else(|| AuthError::InternalError("token response without access_token".to_owned()).into())
    }

    async fn with_grant<T, F, Fut>(&self, call: F) -> HttpResult<T>
    where
        F: Fn(Option<String>) -> Fut,
        Fut: Future<Output = HttpResult<T>>,
    {
        match call(None).await {
            Err(error) if needs_grant(&error) => {
                let token = self.grant().await?;
                call(Some(token)).await
            }
            result => result,
        }
    }
}

impl StreamableHttpClient for CredentialsClient {
    type Error = reqwest::Error;

    async fn post_message(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session_id: Option<Arc<str>>,
        _auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> HttpResult<StreamableHttpPostResponse> {
        self.with_grant(|token| {
            self.auth.post_message(
                uri.clone(),
                message.clone(),
                session_id.clone(),
                token,
                custom_headers.clone(),
            )
        })
        .await
    }

    async fn post_message_with_max_sse_event_size(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session_id: Option<Arc<str>>,
        _auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
        max_sse_event_size: usize,
    ) -> HttpResult<StreamableHttpPostResponse> {
        self.with_grant(|token| {
            self.auth.post_message_with_max_sse_event_size(
                uri.clone(),
                message.clone(),
                session_id.clone(),
                token,
                custom_headers.clone(),
                max_sse_event_size,
            )
        })
        .await
    }

    async fn delete_session(
        &self,
        uri: Arc<str>,
        session_id: Arc<str>,
        _auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> HttpResult<()> {
        self.with_grant(|token| {
            self.auth
                .delete_session(uri.clone(), session_id.clone(), token, custom_headers.clone())
        })
        .await
    }

    async fn get_stream(
        &self,
        uri: Arc<str>,
        session_id: Option<Arc<str>>,
        last_event_id: Option<String>,
        _auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> HttpResult<BoxStream<'static, Result<Sse, SseError>>> {
        self.with_grant(|token| {
            self.auth.get_stream(
                uri.clone(),
                session_id.clone(),
                last_event_id.clone(),
                token,
                custom_headers.clone(),
            )
        })
        .await
    }

    async fn get_stream_with_max_sse_event_size(
        &self,
        uri: Arc<str>,
        session_id: Option<Arc<str>>,
        last_event_id: Option<String>,
        _auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
        max_sse_event_size: usize,
    ) -> HttpResult<BoxStream<'static, Result<Sse, SseError>>> {
        self.with_grant(|token| {
            self.auth.get_stream_with_max_sse_event_size(
                uri.clone(),
                session_id.clone(),
                last_event_id.clone(),
                token,
                custom_headers.clone(),
                max_sse_event_size,
            )
        })
        .await
    }
}

fn auth_error(error: &AuthError) -> McpError {
    McpError::transport(format!("MCP authorization failed: {error}"))
}

async fn credentials_client(url: &Url, credentials: &McpClientCredentials) -> Result<CredentialsClient, McpError> {
    let manager = if credentials.allow_private_addresses {
        tracing::debug!(
            "client_id=<{}> | allowing private addresses in mcp authorization metadata",
            credentials.client_id
        );
        rmcp::transport::AuthorizationManager::new_allowing_private_addresses(url.as_str()).await
    } else {
        rmcp::transport::AuthorizationManager::new(url.as_str()).await
    }
    .map_err(|error| auth_error(&error))?;
    let mut state = OAuthState::Unauthorized(manager);
    let config = ClientCredentialsConfig::ClientSecret {
        client_id: credentials.client_id.clone(),
        client_secret: credentials.client_secret.clone(),
        scopes: credentials.scopes.clone().unwrap_or_default(),
        resource: Some(url.to_string()),
    };
    state
        .authenticate_client_credentials(config.clone())
        .await
        .map_err(|error| auth_error(&error))?;
    let manager = state
        .into_authorization_manager()
        .ok_or_else(|| McpError::transport("MCP authorization failed: no authorized session"))?;
    Ok(CredentialsClient {
        auth: AuthClient::new(reqwest::Client::new(), manager),
        config: Arc::new(config),
    })
}

fn header_map(headers: &BTreeMap<String, String>) -> Result<HashMap<HeaderName, HeaderValue>, McpError> {
    headers
        .iter()
        .map(|(name, value)| {
            let header = HeaderName::from_bytes(name.as_bytes())
                .map_err(|error| McpError::other(format!("Invalid header name \"{name}\": {error}")))?;
            let value = HeaderValue::from_str(value)
                .map_err(|error| McpError::other(format!("Invalid header value for \"{name}\": {error}")))?;
            Ok((header, value))
        })
        .collect()
}

async fn start(
    url: Url,
    headers: HashMap<HeaderName, HeaderValue>,
    auth: HttpAuth,
) -> Result<BoxedTransport, McpError> {
    let config = StreamableHttpClientTransportConfig::with_uri(url.as_str()).custom_headers(headers);
    let transport = match auth {
        HttpAuth::None => BoxedTransport::new(StreamableHttpClientTransport::with_client(
            reqwest::Client::new(),
            config,
        )),
        HttpAuth::Provider(provider) => BoxedTransport::new(StreamableHttpClientTransport::with_client(
            ProviderClient {
                inner: reqwest::Client::new(),
                provider,
            },
            config,
        )),
        HttpAuth::Credentials(credentials) => {
            let client = credentials_client(&url, &credentials).await?;
            BoxedTransport::new(StreamableHttpClientTransport::with_client(client, config))
        }
    };
    Ok(transport)
}

/// The streamable HTTP transport for `url`, built afresh on every connect.
pub(crate) fn streamable_http(
    url: &str,
    headers: &BTreeMap<String, String>,
    auth: HttpAuth,
) -> Result<McpTransport, McpError> {
    let url = Url::parse(url).map_err(|error| McpError::other(format!("Invalid URL \"{url}\": {error}")))?;
    let headers = header_map(headers)?;
    let factory = Arc::new(move || -> BoxFuture<'static, Result<BoxedTransport, McpError>> {
        Box::pin(start(url.clone(), headers.clone(), auth.clone()))
    });
    Ok(McpTransport::from_factory("streamable-http", factory))
}
