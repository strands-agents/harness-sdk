//! Prompt-caching translation both OpenAI adapters share: the routing key and retention fields.
//! Content-level Responses checkpoints are placed by the Responses adapter; older models and Chat
//! Completions cache implicitly.

use crate::logging::warn_once;
use crate::models::{CacheConfig, CacheKey, CacheSectionSetting, CacheStrategy};
use crate::types::{AgentMetadata, JsonObject, JsonValue};

/// The `prompt_cache_retention` literals; a `ttl` maps only on an exact match.
const RETENTION_LITERALS: [&str; 2] = ["in_memory", "24h"];

/// The lifetimes `prompt_cache_options.ttl` and `prompt_cache_breakpoint.ttl` take on models that
/// take cache points (`CACHE_LIFETIMES`).
pub(super) const CACHE_LIFETIMES: [&str; 2] = ["30m", "12h"];

/// Whether `ttl` names a cache lifetime.
pub(super) fn is_cache_lifetime(ttl: &str) -> bool {
    CACHE_LIFETIMES.contains(&ttl)
}

fn is_set_to_other_than_true(setting: Option<&CacheSectionSetting>) -> bool {
    setting.is_some_and(|setting| *setting != CacheSectionSetting::Enabled(true))
}

/// Whether a placement field is set to something other than its default.
fn has_placement_config(cache_config: &CacheConfig, supports_message_caching: bool) -> bool {
    (!supports_message_caching
        && cache_config
            .strategy
            .is_some_and(|strategy| strategy != CacheStrategy::Auto))
        || is_set_to_other_than_true(cache_config.tools_ttl.as_ref())
        || is_set_to_other_than_true(cache_config.system_prompt_ttl.as_ref())
        || (!supports_message_caching && is_set_to_other_than_true(cache_config.messages_ttl.as_ref()))
}

/// The prompt-cache routing key: the configured key, none when disabled, else
/// `strands-<sessionId>` when the agent has a session.
fn resolve_cache_key(cache_config: &CacheConfig, agent_metadata: Option<&AgentMetadata>) -> Option<String> {
    match &cache_config.cache_key {
        Some(CacheKey::Key(key)) => Some(key.clone()),
        Some(CacheKey::Disabled) => None,
        None => agent_metadata
            .and_then(|metadata| metadata.session_id.as_ref())
            .map(|session_id| format!("strands-{session_id}")),
    }
}

/// Warns once that a `ttl` is not an OpenAI retention value.
fn warn_unsupported_retention(ttl: &str) {
    warn_once(&format!(
        "ttl=<{ttl}> | cacheConfig.ttl is not an openai retention value, ignoring"
    ));
}

/// Maps a cache config onto a request in place.
///
/// A value already in `request` (from the user's `params`) wins; this fills in only what `params`
/// left unset. On models that take cache points, a `ttl` naming a cache lifetime becomes the
/// default `prompt_cache_options.ttl`; otherwise a retention literal maps to
/// `prompt_cache_retention`, and any other `ttl` is ignored with a one-time warning.
pub(super) fn apply_cache_config(
    request: &mut JsonObject,
    cache_config: Option<&CacheConfig>,
    agent_metadata: Option<&AgentMetadata>,
    supports_message_caching: bool,
) {
    let Some(cache_config) = cache_config else {
        return;
    };
    if has_placement_config(cache_config, supports_message_caching) {
        warn_once(if supports_message_caching {
            "openai responses caching | toolsTTL and systemPromptTTL are not applied"
        } else {
            "openai caches prefixes automatically server-side | strategy, toolsTTL, systemPromptTTL and messagesTTL have no effect"
        });
    }
    let cache_key = resolve_cache_key(cache_config, agent_metadata).filter(|key| !key.is_empty());
    if let Some(cache_key) = cache_key
        && !request.contains_key("prompt_cache_key")
    {
        request.insert("prompt_cache_key".to_owned(), cache_key.into());
    }
    let ttl = cache_config.ttl.as_deref();
    match ttl {
        Some(ttl) if supports_message_caching && is_cache_lifetime(ttl) => {
            let mut options = JsonObject::new();
            options.insert("ttl".to_owned(), ttl.into());
            if let Some(JsonValue::Object(existing)) = request.get("prompt_cache_options") {
                options.extend(existing.clone());
            }
            request.insert("prompt_cache_options".to_owned(), JsonValue::Object(options));
        }
        _ if request.contains_key("prompt_cache_retention") => {}
        Some(ttl) if RETENTION_LITERALS.contains(&ttl) => {
            request.insert("prompt_cache_retention".to_owned(), ttl.into());
        }
        Some(ttl) => warn_unsupported_retention(ttl),
        None => {}
    }
    if let Some(CacheSectionSetting::Ttl(messages_ttl)) = &cache_config.messages_ttl
        && supports_message_caching
        && !is_cache_lifetime(messages_ttl)
    {
        warn_once(&format!(
            "messages_ttl=<{messages_ttl}> | cacheConfig.messagesTTL is not an openai cache lifetime, ignoring"
        ));
    }
}
