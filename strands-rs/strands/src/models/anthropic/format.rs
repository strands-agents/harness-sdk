//! Request formatting for the Messages API.

use super::client::ApiVersion;
use super::{AnthropicModelConfig, COMPACTION_BETA, TURN_SCOPED_SYSTEM_BETA};
use crate::error::{Error, Result};
use crate::logging::warn_once;
use crate::models::model_info::{ModelInfo, PromptCaching};
use crate::models::thinking_binding::{THINKING_BINDING_BETA, thinking_with_drop_block};
use crate::models::{CacheSectionSetting, CacheStrategy, ResolvedCacheSection, resolve_cache_section};
use crate::types::media::base64_bytes;
use crate::types::{
    ContentBlock, DocumentBlock, DocumentFormat, DocumentSource, ImageBlock, ImageFormat, ImageSource, JsonObject,
    JsonValue, Message, ReasoningBlock, Role, SummaryBlock, SystemContentBlock, SystemPrompt, ToolChoice,
    ToolResultBlock, ToolResultContent, ToolResultStatus, ToolSpec,
};

/// `ephemeral` is the only cache type the Anthropic API supports.
const ANTHROPIC_CACHE_TYPE: &str = "ephemeral";

/// API version 2026-10-21 removed the sampling params and rejects document blocks in assistant
/// messages.
const SAMPLING_PARAMS_REMOVED_VERSION: &str = "2026-10-21";
const REMOVED_SAMPLING_PARAMS: [&str; 3] = ["temperature", "top_p", "top_k"];

/// Document formats sent as text.
const TEXT_FILE_FORMATS: [DocumentFormat; 6] = [
    DocumentFormat::Txt,
    DocumentFormat::Md,
    DocumentFormat::Csv,
    DocumentFormat::Json,
    DocumentFormat::Xml,
    DocumentFormat::Html,
];

/// Block types the API accepts `cache_control` on.
const CACHEABLE_BLOCK_TYPES: [&str; 5] = ["text", "image", "tool_use", "tool_result", "document"];

/// The parts of a stream request that shape the Messages request.
#[derive(Debug, Clone, Copy, Default)]
pub(super) struct FormatOptions<'a> {
    pub(super) system_prompt: Option<&'a SystemPrompt>,
    pub(super) tool_specs: &'a [ToolSpec],
    pub(super) tool_choice: Option<&'a ToolChoice>,
    pub(super) dynamic_trailing_blocks: usize,
}

/// A snapshot of what formatting reads from the model.
pub(super) struct Formatter<'a> {
    pub(super) config: &'a AnthropicModelConfig,
    pub(super) model_info: ModelInfo,
    pub(super) api_version: Option<&'a ApiVersion>,
    pub(super) drops_stale_thinking: bool,
    pub(super) client_betas: &'a [String],
    pub(super) max_tokens: u64,
}

fn object(pairs: impl IntoIterator<Item = (&'static str, JsonValue)>) -> JsonValue {
    JsonValue::Object(pairs.into_iter().map(|(key, value)| (key.to_owned(), value)).collect())
}

fn text_block(text: impl Into<String>) -> JsonValue {
    object([("type", "text".into()), ("text", JsonValue::String(text.into()))])
}

fn block_type(block: &JsonValue) -> &str {
    block.get("type").and_then(JsonValue::as_str).unwrap_or_default()
}

/// Whether `block` is a compaction block Anthropic returned.
pub(super) fn is_compaction(block: &ContentBlock) -> bool {
    matches!(block, ContentBlock::Summary(summary) if summary.provider.as_deref() == Some("anthropic"))
}

/// The messages from the last compaction block, which stands in for everything before it, or all
/// of them. The API rejects any content before a compaction block.
pub(super) fn from_last_compaction(messages: &[Message]) -> Vec<Message> {
    for (index, message) in messages.iter().enumerate().rev() {
        let Some(position) = message.content.iter().rposition(is_compaction) else {
            continue;
        };
        let first = Message::new(message.role, message.content[position..].to_vec());
        return std::iter::once(first)
            .chain(messages[index + 1..].iter().cloned())
            .collect();
    }
    messages.to_vec()
}

/// A server tool's `name`, or its `type` for a toolset, which has none.
fn server_tool_name(tool: &JsonObject) -> String {
    match tool.get("name") {
        Some(JsonValue::String(name)) => name.clone(),
        Some(name) => name.to_string(),
        None => tool
            .get("type")
            .and_then(JsonValue::as_str)
            .unwrap_or_default()
            .to_owned(),
    }
}

/// Validates that `anthropic_tools` holds JSON objects and no function tool definitions.
pub(super) fn validate_anthropic_tools(tools: &[JsonValue]) -> Result<()> {
    if tools.iter().any(|tool| !tool.is_object()) {
        return Err(Error::other("'anthropic_tools' entries must be JSON objects"));
    }
    if tools.iter().any(|tool| tool.get("input_schema").is_some()) {
        return Err(Error::other(
            "anthropicTools should not contain function tool definitions. Use the standard tools interface for \
             function calling tools. anthropicTools is reserved for Anthropic server-side tools like web_search, \
             web_fetch, and code_execution.",
        ));
    }
    Ok(())
}

impl Formatter<'_> {
    pub(super) fn model_id(&self) -> &str {
        self.config.model_id.as_deref().unwrap_or_default()
    }

    pub(super) fn server_side_summary(&self) -> bool {
        self.model_info.capabilities.server_side_summary == Some(true)
    }

    /// Whether the request goes to an API version that dropped the sampling params and assistant
    /// documents.
    fn uses_current_api_version(&self) -> bool {
        self.api_version
            .is_some_and(|version| version.version.as_str() >= SAMPLING_PARAMS_REMOVED_VERSION)
    }

    /// The API rejects these params with a 400, so a request that carries them fails here with the
    /// fixes instead.
    fn reject_removed_sampling_params(&self, request: &JsonObject) -> Result<()> {
        let Some(version) = self.api_version.filter(|_| self.uses_current_api_version()) else {
            return Ok(());
        };
        let set: Vec<&str> = REMOVED_SAMPLING_PARAMS
            .into_iter()
            .filter(|name| request.contains_key(*name))
            .collect();
        if set.is_empty() {
            return Ok(());
        }
        let (verb, noun) = if set.len() == 1 {
            ("is", "param")
        } else {
            ("are", "params")
        };
        Err(Error::other(format!(
            "{} {verb} not supported by Anthropic API version {}, {}. Remove the {noun}, or pin API version \
             2023-06-01 for models that still honor them: client_config: AnthropicClientConfig {{ default_headers: \
             {{ 'anthropic-version': '2023-06-01' }} }}",
            set.join(", "),
            version.version,
            version.origin
        )))
    }

    /// Resolves a cache section, disabled when `cache_config` is unset.
    fn cache_section(&self, section: Option<&CacheSectionSetting>) -> ResolvedCacheSection {
        let disabled = ResolvedCacheSection {
            enabled: false,
            ttl: None,
        };
        let Some(cache_config) = &self.config.cache_config else {
            return disabled;
        };
        let strategy = cache_config.strategy.unwrap_or_default();
        if strategy == CacheStrategy::Auto
            && self.model_info.capabilities.prompt_caching == Some(PromptCaching::Unsupported)
        {
            warn_once(&format!(
                "model_id=<{}> | cacheConfig is enabled but the model info says this model does not support prompt caching, ignoring",
                self.model_id()
            ));
            return disabled;
        }
        resolve_cache_section(section, &[cache_config.ttl.as_deref()])
    }

    fn tools_cache(&self) -> ResolvedCacheSection {
        self.cache_section(
            self.config
                .cache_config
                .as_ref()
                .and_then(|config| config.tools_ttl.as_ref()),
        )
    }

    fn messages_cache(&self) -> ResolvedCacheSection {
        self.cache_section(
            self.config
                .cache_config
                .as_ref()
                .and_then(|config| config.messages_ttl.as_ref()),
        )
    }

    fn system_cache(&self) -> ResolvedCacheSection {
        self.cache_section(
            self.config
                .cache_config
                .as_ref()
                .and_then(|config| config.system_prompt_ttl.as_ref()),
        )
    }

    /// The request body.
    pub(super) fn format_request(&self, messages: &[Message], options: &FormatOptions<'_>) -> Result<JsonObject> {
        if self.model_id().is_empty() {
            return Err(Error::other("Model ID is required"));
        }
        let compacted;
        let messages = if self.server_side_summary() {
            compacted = from_last_compaction(messages);
            compacted.as_slice()
        } else {
            messages
        };

        let mut request = JsonObject::new();
        request.insert("model".to_owned(), self.model_id().into());
        request.insert("max_tokens".to_owned(), self.max_tokens.into());
        request.insert(
            "messages".to_owned(),
            JsonValue::Array(self.format_messages(messages, options.dynamic_trailing_blocks)?),
        );
        request.insert("stream".to_owned(), true.into());

        if let Some(system) = options
            .system_prompt
            .and_then(|prompt| self.format_system_prompt(prompt))
        {
            request.insert("system".to_owned(), system);
        }

        let tools = self.format_tools(options);
        if let (false, Some(choice)) = (tools.is_empty(), options.tool_choice) {
            request.insert("tool_choice".to_owned(), format_tool_choice(choice));
        }

        // `stop_sequences` goes in before the sampling params and `params`, which can replace it.
        if let Some(stop_sequences) = &self.config.stop_sequences {
            request.insert("stop_sequences".to_owned(), stop_sequences.clone().into());
        }
        if let Some(temperature) = self.config.temperature {
            request.insert("temperature".to_owned(), temperature.into());
        }
        if let Some(top_p) = self.config.top_p {
            request.insert("top_p".to_owned(), top_p.into());
        }
        for (key, value) in self
            .config
            .params
            .as_ref()
            .and_then(JsonValue::as_object)
            .into_iter()
            .flatten()
        {
            request.insert(key.clone(), value.clone());
        }
        self.reject_removed_sampling_params(&request)?;
        if self.drops_stale_thinking
            && let Some(thinking) = thinking_with_drop_block(request.get("thinking"), is_tool_forced(&request))
        {
            request.insert("thinking".to_owned(), JsonValue::Object(thinking));
        }
        if tools.is_empty() {
            request.shift_remove("tools");
        } else {
            request.insert("tools".to_owned(), JsonValue::Array(tools));
        }
        Ok(request)
    }

    /// The function tools, then the server tools unless a tool is forced, with a cache point on the
    /// last one.
    fn format_tools(&self, options: &FormatOptions<'_>) -> Vec<JsonValue> {
        let mut tools: Vec<JsonValue> = options.tool_specs.iter().map(format_tool_spec).collect();
        let server_tools: Vec<&JsonObject> = self
            .config
            .anthropic_tools
            .iter()
            .flatten()
            .filter_map(JsonValue::as_object)
            .chain(
                self.config
                    .params
                    .as_ref()
                    .and_then(|params| params.get("tools"))
                    .and_then(JsonValue::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(JsonValue::as_object),
            )
            .collect();
        match options.tool_choice {
            None | Some(ToolChoice::Auto) => {
                tools.extend(server_tools.into_iter().map(|tool| JsonValue::Object(tool.clone())));
            }
            Some(choice) if !server_tools.is_empty() => {
                let names: Vec<String> = server_tools.into_iter().map(server_tool_name).collect();
                tracing::warn!(
                    "tool_choice=<{}>, server_tools=<{}> | forced tool call, omitting server tools",
                    tool_choice_key(choice),
                    names.join(",")
                );
            }
            Some(_) => {}
        }
        let cache = self.tools_cache();
        if let (true, Some(JsonValue::Object(last))) = (cache.enabled, tools.last_mut()) {
            last.insert("cache_control".to_owned(), cache_control(cache.ttl.as_deref()));
        }
        tools
    }

    /// Formats the system prompt, adding a cache point at its end when caching is on; `None` when
    /// nothing remains.
    fn format_system_prompt(&self, system_prompt: &SystemPrompt) -> Option<JsonValue> {
        let cache = self.system_cache();
        let blocks = match system_prompt {
            SystemPrompt::Text(text) if !cache.enabled => return Some(JsonValue::String(text.clone())),
            SystemPrompt::Text(text) => {
                let mut block = text_block(text.clone());
                set_cache_control(&mut block, cache.ttl.as_deref());
                return Some(JsonValue::Array(vec![block]));
            }
            SystemPrompt::Blocks(blocks) => blocks,
        };
        let mut formatted = Vec::new();
        let mut placed = false;
        let mut index = 0;
        while index < blocks.len() {
            let block = &blocks[index];
            index += 1;
            let text = match block {
                SystemContentBlock::Text(text) => text,
                SystemContentBlock::GuardContent(_) => {
                    tracing::warn!(
                        "block_type=<guardContentBlock> | guard content not supported in anthropic system prompt | skipping"
                    );
                    continue;
                }
                _ => continue,
            };
            let mut block = text_block(text.text.clone());
            if let Some(SystemContentBlock::CachePoint(point)) = blocks.get(index) {
                let ttl = point
                    .ttl
                    .as_deref()
                    .filter(|ttl| !ttl.is_empty())
                    .or(cache.ttl.as_deref());
                set_cache_control(&mut block, ttl);
                placed = true;
                index += 1;
            }
            formatted.push(block);
        }
        if cache.enabled
            && !placed
            && let Some(last) = formatted.last_mut()
        {
            set_cache_control(last, cache.ttl.as_deref());
        }
        (!formatted.is_empty()).then_some(JsonValue::Array(formatted))
    }

    fn format_messages(&self, messages: &[Message], dynamic_trailing_blocks: usize) -> Result<Vec<JsonValue>> {
        let cache = self.messages_cache();
        // The cache point goes on the last user message with content, not counting cache points.
        let target = cache
            .enabled
            .then(|| {
                messages.iter().rposition(|message| {
                    message.role == Role::User
                        && message
                            .content
                            .iter()
                            .any(|block| !matches!(block, ContentBlock::CachePoint(_)))
                })
            })
            .flatten();
        let mut stripped = 0;
        let mut formatted = Vec::with_capacity(messages.len());
        for (index, message) in messages.iter().enumerate() {
            let is_target = target == Some(index);
            let (content, stripped_here) =
                self.format_message_content(index, message, &cache, is_target, dynamic_trailing_blocks)?;
            stripped += stripped_here;
            formatted.push(content);
        }
        if stripped > 0 {
            tracing::warn!(
                "count=<{stripped}> | stripped extra cache points, cacheConfig keeps the first cache point in the last user message; unset cacheConfig to keep every cache point"
            );
        }
        Ok(request_messages(
            messages,
            formatted,
            self.model_info.capabilities.temporary_messages == Some(true),
        ))
    }

    /// One message's formatted content and the count of cache points stripped from it.
    fn format_message_content(
        &self,
        index: usize,
        message: &Message,
        cache: &ResolvedCacheSection,
        is_target: bool,
        dynamic_trailing_blocks: usize,
    ) -> Result<(Vec<JsonValue>, usize)> {
        let mut content = Vec::new();
        let mut marked = false;
        let mut honored = false;
        let mut stripped = 0;
        for block in &message.content {
            if let ContentBlock::CachePoint(point) = block {
                let point_ttl = point.ttl.as_deref().filter(|ttl| !ttl.is_empty());
                if !cache.enabled {
                    if !attach_cache_control(&mut content, point_ttl, 0) {
                        tracing::warn!("no preceding block accepts a cache point | skipped cache point");
                    }
                } else if is_target && !honored {
                    // A TTL written on the point is more specific than the configured one.
                    honored = true;
                    marked = attach_cache_control(&mut content, point_ttl.or(cache.ttl.as_deref()), 0);
                    if !marked {
                        tracing::warn!(
                            "msg_idx=<{index}> | nothing ahead of the placed cache point can carry one, falling back to automatic placement"
                        );
                    }
                } else {
                    stripped += 1;
                }
                continue;
            }
            let Some(formatted) = self.format_content_block(block)? else {
                continue;
            };
            if block_type(&formatted) == "document"
                && message.role == Role::Assistant
                && self.uses_current_api_version()
            {
                tracing::warn!(
                    "msg_idx=<{index}>, api_version=<{}> | document blocks are not accepted in assistant messages, skipping",
                    self.api_version
                        .map(|version| version.version.as_str())
                        .unwrap_or_default()
                );
                continue;
            }
            content.push(formatted);
        }
        if is_target && !marked {
            if attach_cache_control(&mut content, cache.ttl.as_deref(), dynamic_trailing_blocks) {
                tracing::debug!("msg_idx=<{index}> | added cache point to last user message");
            } else {
                tracing::debug!("msg_idx=<{index}> | no cacheable content block, skipped cache point");
            }
        }
        Ok((content, stripped))
    }

    /// Formats a summary as a compaction block when Anthropic wrote it and compaction is on, else as
    /// text.
    fn format_summary(&self, summary: &SummaryBlock) -> JsonValue {
        if summary.provider.as_deref() != Some("anthropic") || !self.server_side_summary() {
            return text_block(summary.text.clone());
        }
        let mut block = object([("type", "compaction".into()), ("content", summary.text.clone().into())]);
        if let (Some(signature), JsonValue::Object(map)) =
            (summary.signature.as_ref().filter(|s| !s.is_empty()), &mut block)
        {
            map.insert("signature".to_owned(), signature.clone().into());
        }
        block
    }

    fn format_content_block(&self, block: &ContentBlock) -> Result<Option<JsonValue>> {
        Ok(match block {
            ContentBlock::Text(text) => Some(text_block(text.text.clone())),
            ContentBlock::Summary(summary) => Some(self.format_summary(summary)),
            ContentBlock::Image(image) => format_image(image),
            ContentBlock::Document(document) => Some(format_document(document)?),
            ContentBlock::ToolUse(tool_use) => Some(object([
                ("type", "tool_use".into()),
                ("id", tool_use.tool_use_id.clone().into()),
                ("name", tool_use.name.clone().into()),
                ("input", tool_use.input.clone()),
            ])),
            ContentBlock::Video(_) => {
                tracing::warn!("block_type=<videoBlock> | video blocks not supported by anthropic, skipping");
                None
            }
            ContentBlock::ToolResult(result) => Some(self.format_tool_result(result)?),
            ContentBlock::Reasoning(reasoning) => format_reasoning(reasoning),
            ContentBlock::Citations(citations) => {
                let text: String = citations
                    .content
                    .iter()
                    .map(|generated| generated.text.as_str())
                    .collect();
                (!text.is_empty()).then(|| text_block(text))
            }
            _ => None,
        })
    }

    fn format_tool_result(&self, result: &ToolResultBlock) -> Result<JsonValue> {
        let mut inner = Vec::new();
        for item in &result.content {
            let formatted = match item {
                ToolResultContent::Text(text) => Some(text_block(text.text.clone())),
                ToolResultContent::Json(json) => Some(text_block(json.json.to_string())),
                ToolResultContent::Image(image) => self.format_content_block(&ContentBlock::Image(image.clone()))?,
                ToolResultContent::Video(video) => self.format_content_block(&ContentBlock::Video(video.clone()))?,
                ToolResultContent::Document(document) => {
                    self.format_content_block(&ContentBlock::Document(document.clone()))?
                }
                _ => None,
            };
            inner.extend(formatted);
        }
        let content = match inner.as_slice() {
            [only] if block_type(only) == "text" => only.get("text").cloned().unwrap_or_default(),
            _ => JsonValue::Array(inner),
        };
        Ok(object([
            ("type", "tool_result".into()),
            ("tool_use_id", result.tool_use_id.clone().into()),
            ("content", content),
            ("is_error", (result.status == ToolResultStatus::Error).into()),
        ]))
    }

    /// The `anthropic-beta` header for a formatted request: the configured betas (or the client's
    /// when only required betas apply), plus `extra` and the betas the request needs.
    pub(super) fn request_beta(&self, request: &JsonObject, extra: &[&str]) -> Option<String> {
        let turn_scoped = request
            .get("messages")
            .and_then(JsonValue::as_array)
            .is_some_and(|messages| messages.iter().any(|message| message.get("clear_at").is_some()));
        let required: Vec<&str> = extra
            .iter()
            .copied()
            .chain(self.drops_stale_thinking.then_some(THINKING_BINDING_BETA))
            .chain(turn_scoped.then_some(TURN_SCOPED_SYSTEM_BETA))
            .collect();
        let configured = self.config.betas.as_deref().unwrap_or_default();
        // Request headers replace client headers of the same name, so betas set on the client are
        // carried over.
        let betas = if !required.is_empty() && configured.is_empty() {
            self.client_betas
        } else {
            configured
        };
        let mut unique: Vec<&str> = Vec::new();
        for beta in betas.iter().map(String::as_str).chain(required) {
            if !unique.contains(&beta) {
                unique.push(beta);
            }
        }
        (!unique.is_empty()).then(|| unique.join(","))
    }

    /// The compaction beta when `messages` carry a compaction block this model sends as one.
    pub(super) fn compaction_betas(&self, messages: &[Message]) -> Vec<&'static str> {
        let carries = messages.iter().any(|message| message.content.iter().any(is_compaction));
        if self.server_side_summary() && carries {
            vec![COMPACTION_BETA]
        } else {
            Vec::new()
        }
    }
}

/// Whether the request forces a tool call, which rules thinking out.
pub(super) fn is_tool_forced(request: &JsonObject) -> bool {
    matches!(
        request
            .get("tool_choice")
            .and_then(|choice| choice.get("type"))
            .and_then(JsonValue::as_str),
        Some("any" | "tool")
    )
}

fn format_tool_spec(spec: &ToolSpec) -> JsonValue {
    let mut tool = JsonObject::new();
    tool.insert("name".to_owned(), spec.name.clone().into());
    tool.insert("description".to_owned(), spec.description.clone().into());
    if let Some(schema) = &spec.input_schema {
        tool.insert("input_schema".to_owned(), schema.clone());
    }
    JsonValue::Object(tool)
}

fn tool_choice_key(choice: &ToolChoice) -> &'static str {
    match choice {
        ToolChoice::Auto => "auto",
        ToolChoice::Any => "any",
        ToolChoice::Tool { .. } => "tool",
    }
}

fn format_tool_choice(choice: &ToolChoice) -> JsonValue {
    match choice {
        ToolChoice::Tool { name } => object([("type", "tool".into()), ("name", name.clone().into())]),
        other => object([("type", tool_choice_key(other).into())]),
    }
}

/// An Anthropic `cache_control` value. An empty or absent TTL leaves the API default.
fn cache_control(ttl: Option<&str>) -> JsonValue {
    let mut control = object([("type", ANTHROPIC_CACHE_TYPE.into())]);
    if let (Some(ttl), JsonValue::Object(map)) = (ttl.filter(|ttl| !ttl.is_empty()), &mut control) {
        map.insert("ttl".to_owned(), ttl.into());
    }
    control
}

fn set_cache_control(block: &mut JsonValue, ttl: Option<&str>) {
    if let JsonValue::Object(map) = block {
        map.insert("cache_control".to_owned(), cache_control(ttl));
    }
}

/// Marks the last formatted block the API accepts `cache_control` on, skipping `skip_trailing`
/// blocks rebuilt every call so the cache point stays ahead of them. Returns whether one was marked.
fn attach_cache_control(content: &mut [JsonValue], ttl: Option<&str>, skip_trailing: usize) -> bool {
    let end = content.len().saturating_sub(skip_trailing);
    let Some(block) = content[..end]
        .iter_mut()
        .rev()
        .find(|block| CACHEABLE_BLOCK_TYPES.contains(&block_type(block)))
    else {
        return false;
    };
    set_cache_control(block, ttl);
    true
}

fn image_media_type(format: ImageFormat) -> &'static str {
    match format {
        ImageFormat::Png => "image/png",
        ImageFormat::Gif => "image/gif",
        ImageFormat::Webp => "image/webp",
        _ => "image/jpeg",
    }
}

fn format_image(image: &ImageBlock) -> Option<JsonValue> {
    let source = match &image.source {
        ImageSource::Bytes(bytes) => object([
            ("type", "base64".into()),
            ("media_type", image_media_type(image.format).into()),
            ("data", base64_bytes::encode(bytes).into()),
        ]),
        ImageSource::Url(url) => object([("type", "url".into()), ("url", url.clone().into())]),
        _ => {
            tracing::warn!(
                "source_type=<imageSourceS3Location> | s3 location sources are not supported by anthropic | skipping"
            );
            return None;
        }
    };
    Some(object([("type", "image".into()), ("source", source)]))
}

fn document_format_name(format: DocumentFormat) -> String {
    serde_json::to_value(format)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn document_source_type(source: &DocumentSource) -> &'static str {
    match source {
        DocumentSource::Bytes(_) => "documentSourceBytes",
        DocumentSource::Text(_) => "documentSourceText",
        DocumentSource::Content(_) => "documentSourceContentBlock",
        _ => "documentSourceS3Location",
    }
}

fn format_document(document: &DocumentBlock) -> Result<JsonValue> {
    if let (DocumentFormat::Pdf, DocumentSource::Bytes(bytes)) = (document.format, &document.source) {
        let mut block = JsonObject::new();
        block.insert("type".to_owned(), "document".into());
        block.insert(
            "source".to_owned(),
            object([
                ("type", "base64".into()),
                ("media_type", "application/pdf".into()),
                ("data", base64_bytes::encode(bytes).into()),
            ]),
        );
        if !document.name.is_empty() {
            block.insert("title".to_owned(), document.name.clone().into());
        }
        return Ok(JsonValue::Object(block));
    }
    if TEXT_FILE_FORMATS.contains(&document.format) {
        let text = match &document.source {
            DocumentSource::Text(text) => Some(text.clone()),
            DocumentSource::Bytes(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
            _ => None,
        };
        if let Some(text) = text.filter(|text| !text.is_empty()) {
            return Ok(text_block(text));
        }
    }
    Err(Error::other(format!(
        "Unsupported document format or source for Anthropic: format={}, source={}",
        document_format_name(document.format),
        document_source_type(&document.source)
    )))
}

fn format_reasoning(reasoning: &ReasoningBlock) -> Option<JsonValue> {
    if let Some(signature) = reasoning.signature.as_ref().filter(|signature| !signature.is_empty()) {
        return Some(object([
            ("type", "thinking".into()),
            ("thinking", reasoning.text.clone().unwrap_or_default().into()),
            ("signature", signature.clone().into()),
        ]));
    }
    let redacted = reasoning.redacted_content.as_ref()?;
    Some(object([
        ("type", "redacted_thinking".into()),
        ("data", base64_bytes::encode(redacted).into()),
    ]))
}

fn role_name(role: Role) -> &'static str {
    match role {
        Role::Assistant => "assistant",
        _ => "user",
    }
}

/// Drops the formatted messages left empty, which the API rejects anywhere but the trailing
/// assistant turn. With temporary messages, each user message's injected text follows it as a
/// turn-scoped system message.
fn request_messages(messages: &[Message], formatted: Vec<Vec<JsonValue>>, temporary_messages: bool) -> Vec<JsonValue> {
    let kept: Vec<(&Message, JsonValue)> = messages
        .iter()
        .zip(formatted)
        .filter(|(_, content)| !content.is_empty())
        .map(|(source, content)| {
            let message = object([
                ("role", role_name(source.role).into()),
                ("content", JsonValue::Array(content)),
            ]);
            (source, message)
        })
        .collect();
    let roles: Vec<Role> = kept.iter().map(|(source, _)| source.role).collect();
    let mut result = Vec::with_capacity(kept.len());
    for (index, (source, message)) in kept.into_iter().enumerate() {
        result.push(message);
        if !temporary_messages || source.role != Role::User || roles.get(index + 1) == Some(&Role::User) {
            continue;
        }
        // A system message followed directly by a user message is rejected, and no assistant turn
        // can have read it, so it is left out.
        result.extend(turn_scoped_system_message(source));
    }
    result
}

/// The message's injected text as a system message the model reads only until a later user
/// message exists. It never carries `cache_control`: a cleared message is not part of any cache
/// key.
fn turn_scoped_system_message(message: &Message) -> Option<JsonValue> {
    let content: Vec<JsonValue> = message
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Injected(injected) => Some(text_block(injected.text.clone())),
            _ => None,
        })
        .collect();
    (!content.is_empty()).then(|| {
        object([
            ("role", "system".into()),
            ("content", JsonValue::Array(content)),
            ("clear_at", "next_user_message".into()),
        ])
    })
}
