//! Converse request formatting.
//!
//! Requests are built as Converse JSON, with bytes base64-encoded as on the REST wire.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::json;

use super::{BedrockModelConfig, IncludeToolResultStatus};
use crate::error::{Error, Result};
use crate::logging::warn_once;
use crate::models::bedrock_cache::bedrock_limits_cache_points;
use crate::models::model::{
    CacheSectionSetting, ModelRequest, ResolvedCacheSection, resolve_cache_section, resolve_max_tokens,
};
use crate::models::model_info::{ModelInfo, PromptCaching};
use crate::models::native_output::to_native_output_schema;
use crate::models::strict_schema::{ensure_strict_json_schema, find_unsupported_strict_keywords};
use crate::models::thinking_binding::{THINKING_BINDING_BETA, thinking_with_drop_block};
use crate::tools::{NOOP_TOOL_SPEC, STRUCTURED_OUTPUT_TOOL_NAME};
use crate::types::{
    AudioSource, Citation, CitationLocation, CitationsBlock, ContentBlock, DocumentBlock, DocumentSource,
    GuardContentBlock, ImageSource, JsonObject, JsonSchema, JsonValue, Message, ReasoningBlock, Role, S3Location,
    SystemContentBlock, SystemPrompt, ToolChoice, ToolResultBlock, ToolResultContent, ToolSpec, VideoFormat,
    VideoSource,
};

/// Models Bedrock documents as accepting `status` in tool results (`MODELS_INCLUDE_STATUS`).
/// An allow-list: undocumented models may accept it or reject it with a validation error.
const MODELS_INCLUDE_STATUS: [&str; 2] = ["amazon.nova", "anthropic.claude"];

/// Models that reject any reasoning text replayed in history (`MODELS_REJECT_REASONING_TEXT`).
const MODELS_REJECT_REASONING_TEXT: [&str; 16] = [
    "amazon.nova-lite",
    "amazon.nova-pro",
    "google.gemma",
    "meta.llama",
    "mistral.devstral",
    "mistral.ministral",
    "mistral.mistral-large",
    "nvidia.nemotron-nano-9b",
    "nvidia.nemotron-super",
    "openai.gpt-5",
    "openai.gpt-6",
    "openai.gpt-daybreak",
    "qwen.qwen3-235b",
    "qwen.qwen3-coder",
    "writer.palmyra",
    "xai.grok",
];

/// The request options the formatter reads, without the agent-only fields.
#[derive(Debug, Clone, Copy, Default)]
pub(super) struct FormatOptions<'a> {
    pub(super) system_prompt: Option<&'a SystemPrompt>,
    pub(super) tool_specs: &'a [ToolSpec],
    pub(super) tool_choice: Option<&'a ToolChoice>,
    pub(super) dynamic_trailing_blocks: usize,
}

impl<'a> FormatOptions<'a> {
    pub(super) fn from_request(request: &'a ModelRequest) -> Self {
        Self {
            system_prompt: request.system_prompt.as_ref(),
            tool_specs: &request.tool_specs,
            tool_choice: request.tool_choice.as_ref(),
            dynamic_trailing_blocks: request.dynamic_trailing_blocks.unwrap_or(0),
        }
    }

    pub(super) fn with_tool_choice(&self, tool_choice: Option<&'a ToolChoice>) -> Self {
        Self { tool_choice, ..*self }
    }
}

/// Formats requests for one configuration.
pub(super) struct Formatter<'a> {
    config: &'a BedrockModelConfig,
    model_info: &'a ModelInfo,
}

fn invalid(message: impl Into<String>) -> Error {
    Error::other(message.into())
}

fn bytes(data: &[u8]) -> JsonValue {
    JsonValue::String(STANDARD.encode(data))
}

impl<'a> Formatter<'a> {
    pub(super) fn new(config: &'a BedrockModelConfig, model_info: &'a ModelInfo) -> Self {
        Self { config, model_info }
    }

    fn model_id(&self) -> &str {
        self.config.model_id_or_default()
    }

    /// Formats a Converse request.
    pub(super) fn format_request(&self, messages: &[Message], options: &FormatOptions<'_>) -> Result<JsonObject> {
        let mut request = JsonObject::new();
        request.insert("modelId".to_owned(), json!(self.model_id()));

        let mut system = self.format_system(options.system_prompt)?;
        if let Some(system) = system.as_mut().filter(|system| self.should_cache_system(system)) {
            system.push(json!({"cachePoint": {"type": "default"}}));
        }
        let tool_config = self.format_tool_config(messages, options);
        if let Some(system) = system.as_mut() {
            self.apply_system_cache_ttl(system, tool_config.as_ref());
        }
        let system_cache_points = system.iter().flatten().filter(|block| is_cache_point(block)).count();
        if let Some(system) = system {
            request.insert("system".to_owned(), JsonValue::Array(system));
        }
        let formatted = self.format_messages(messages, options.dynamic_trailing_blocks, system_cache_points)?;
        request.insert("messages".to_owned(), JsonValue::Array(formatted));
        if let Some(tool_config) = tool_config {
            request.insert("toolConfig".to_owned(), JsonValue::Object(tool_config));
        }
        if let Some(inference_config) = self.inference_config() {
            request.insert("inferenceConfig".to_owned(), JsonValue::Object(inference_config));
        }
        if let Some(fields) = self.additional_request_fields(options.tool_choice) {
            request.insert("additionalModelRequestFields".to_owned(), fields);
        }
        if let Some(paths) = &self.config.additional_response_field_paths {
            request.insert("additionalModelResponseFieldPaths".to_owned(), json!(paths));
        }
        if let Some(JsonValue::Object(args)) = &self.config.additional_args {
            request.extend(args.iter().map(|(key, value)| (key.clone(), value.clone())));
        }
        if let Some(guardrail) = &self.config.guardrail_config {
            let mut config = JsonObject::new();
            config.insert("guardrailIdentifier".to_owned(), json!(guardrail.guardrail_identifier));
            config.insert("guardrailVersion".to_owned(), json!(guardrail.guardrail_version));
            config.insert("trace".to_owned(), json!(guardrail.trace.unwrap_or_default().as_str()));
            if let Some(mode) = guardrail.stream_processing_mode {
                config.insert("streamProcessingMode".to_owned(), json!(mode.as_str()));
            }
            request.insert("guardrailConfig".to_owned(), JsonValue::Object(config));
        }
        Ok(request)
    }

    fn format_system(&self, system_prompt: Option<&SystemPrompt>) -> Result<Option<Vec<JsonValue>>> {
        match system_prompt {
            Some(SystemPrompt::Text(text)) => Ok(Some(vec![json!({"text": text})])),
            Some(SystemPrompt::Blocks(blocks)) if !blocks.is_empty() => {
                blocks.iter().map(format_system_block).collect::<Result<_>>().map(Some)
            }
            _ => Ok(None),
        }
    }

    fn format_tool_config(&self, messages: &[Message], options: &FormatOptions<'_>) -> Option<JsonObject> {
        let has_tool_blocks = messages.iter().any(|message| {
            message
                .content
                .iter()
                .any(|block| matches!(block, ContentBlock::ToolUse(_) | ContentBlock::ToolResult(_)))
        });
        let noop = [NOOP_TOOL_SPEC.clone()];
        let tool_specs = match options.tool_specs {
            [] if has_tool_blocks => &noop[..],
            [] => return None,
            specs => specs,
        };
        let strict_tools = self.config.strict_tools == Some(true);
        let mut tools: Vec<JsonValue> = tool_specs
            .iter()
            .map(|spec| format_tool_spec(spec, strict_tools))
            .collect();
        let section = self.tools_cache_section();
        if section.enabled {
            tools.push(json!({"cachePoint": cache_point(section.ttl.as_deref())}));
        }
        let mut tool_config = JsonObject::new();
        tool_config.insert("tools".to_owned(), JsonValue::Array(tools));
        if let Some(tool_choice) = options.tool_choice {
            tool_config.insert("toolChoice".to_owned(), json!(tool_choice));
        }
        Some(tool_config)
    }

    fn inference_config(&self) -> Option<JsonObject> {
        let mut config = JsonObject::new();
        let base = self.config.to_base();
        if let Some(max_tokens) = resolve_max_tokens(&base, self.model_id()) {
            config.insert("maxTokens".to_owned(), json!(max_tokens));
        }
        if let Some(temperature) = self.config.temperature {
            config.insert("temperature".to_owned(), json!(temperature));
        }
        if let Some(top_p) = self.config.top_p {
            config.insert("topP".to_owned(), json!(top_p));
        }
        if let Some(stop_sequences) = &self.config.stop_sequences {
            config.insert("stopSequences".to_owned(), json!(stop_sequences));
        }
        (!config.is_empty()).then_some(config)
    }

    /// The additional request fields, adjusted for the tool choice: Bedrock does not allow thinking
    /// when the tool choice forces a tool.
    fn additional_request_fields(&self, tool_choice: Option<&ToolChoice>) -> Option<JsonValue> {
        let fields = self.config.additional_request_fields.as_ref()?;
        let Some(object) = fields.as_object().filter(|object| object.contains_key("thinking")) else {
            return Some(fields.clone());
        };
        if matches!(tool_choice, None | Some(ToolChoice::Auto)) {
            return Some(fields.clone());
        }
        let mut rest = object.clone();
        rest.remove("thinking");
        (!rest.is_empty()).then_some(JsonValue::Object(rest))
    }

    /// Whether the configured model takes cache points.
    fn model_takes_cache_points(&self) -> bool {
        match self.model_info.capabilities.prompt_caching {
            Some(caching) => caching == PromptCaching::CachePoints,
            // Unlisted ids (a Claude release newer than the data, a prompt-router or custom-model
            // ARN) keep the name test so caching does not turn off until the data catches up.
            None => {
                let model_id = self.model_id().to_lowercase();
                model_id.contains("claude") || model_id.contains("anthropic")
            }
        }
    }

    /// Whether Converse limits where this model takes cache points (no tools cache point, no TTL,
    /// only directly after text).
    fn limits_cache_points(&self) -> bool {
        bedrock_limits_cache_points(self.model_id())
    }

    fn cache_point_rules(&self, system_cache_points: usize) -> CachePointRules<'_> {
        CachePointRules {
            after_text_only: self.limits_cache_points(),
            model_id: self.model_id(),
            conversation_points: NOVA_CONVERSATION_CACHE_POINTS
                .min(MAX_CACHE_POINTS.saturating_sub(system_cache_points)),
        }
    }

    fn warn_ttl_unsupported(&self) {
        warn_once(&format!(
            "model_id=<{}> | ttl is not supported by this model, using the default cache duration",
            self.model_id()
        ));
    }

    /// Resolves a cache section against `cache_config.ttl`, dropping the TTL with a one-time
    /// warning when the model rejects one.
    fn cache_section(&self, section: Option<&CacheSectionSetting>) -> ResolvedCacheSection {
        let shared_ttl = self.config.cache_config.as_ref().and_then(|cache| cache.ttl.as_deref());
        let resolved = resolve_cache_section(section, &[shared_ttl]);
        if resolved.ttl.is_none() || !self.limits_cache_points() {
            return resolved;
        }
        self.warn_ttl_unsupported();
        ResolvedCacheSection {
            enabled: resolved.enabled,
            ttl: None,
        }
    }

    /// The tools cache section, disabled when caching is off or the model rejects a tools cache
    /// point.
    fn tools_cache_section(&self) -> ResolvedCacheSection {
        let disabled = ResolvedCacheSection {
            enabled: false,
            ttl: None,
        };
        if !self.should_enable_caching() {
            return disabled;
        }
        let tools_ttl = self
            .config
            .cache_config
            .as_ref()
            .and_then(|cache| cache.tools_ttl.as_ref());
        if !self.limits_cache_points() {
            return self.cache_section(tools_ttl);
        }
        let value = match tools_ttl {
            None | Some(CacheSectionSetting::Enabled(false)) => return disabled,
            Some(CacheSectionSetting::Enabled(true)) => "true",
            Some(CacheSectionSetting::Ttl(ttl)) => ttl.as_str(),
        };
        warn_once(&format!(
            "model_id=<{}>, tools_ttl=<{value}> | this model accepts no tool-level cache point, tool definitions are cached only as part of the system prompt prefix",
            self.model_id()
        ));
        disabled
    }

    /// Removes caller-placed TTLs from system cache points when the model rejects any TTL,
    /// warning once.
    fn drop_unsupported_system_ttls(&self, system: &mut [JsonValue]) {
        if !self.limits_cache_points() {
            return;
        }
        for point in system
            .iter_mut()
            .filter_map(|block| block.get_mut("cachePoint"))
            .filter_map(JsonValue::as_object_mut)
        {
            if point
                .get("ttl")
                .and_then(JsonValue::as_str)
                .is_some_and(|ttl| !ttl.is_empty())
            {
                point.shift_remove("ttl");
                self.warn_ttl_unsupported();
            }
        }
    }

    /// Whether cache points are added.
    fn should_enable_caching(&self) -> bool {
        let Some(cache_config) = &self.config.cache_config else {
            return false;
        };
        if matches!(cache_config.strategy, Some(crate::models::CacheStrategy::Anthropic)) {
            return true;
        }
        if self.model_takes_cache_points() {
            return true;
        }
        // A model the provider caches implicitly needs no cache points, so it gets no warning.
        if self.model_info.capabilities.prompt_caching == Some(PromptCaching::Auto) {
            return false;
        }
        warn_once(&format!(
            "model_id=<{}> | cache_config is enabled but this model does not support automatic caching",
            self.model_id()
        ));
        false
    }

    fn should_cache_system(&self, system: &[JsonValue]) -> bool {
        if !self.should_enable_caching() {
            return false;
        }
        let disabled = matches!(
            self.config
                .cache_config
                .as_ref()
                .and_then(|cache| cache.system_prompt_ttl.as_ref()),
            Some(crate::models::CacheSectionSetting::Enabled(false))
        );
        !disabled && !system.is_empty() && !system.iter().any(|block| block.get("cachePoint").is_some())
    }

    /// Fills the resolved system-section TTL into system cache points that carry none.
    fn apply_system_cache_ttl(&self, system: &mut [JsonValue], tool_config: Option<&JsonObject>) {
        if !self.should_enable_caching() {
            return;
        }
        self.drop_unsupported_system_ttls(system);
        let cache_config = self.config.cache_config.as_ref();
        let system_setting = cache_config.and_then(|cache| cache.system_prompt_ttl.as_ref());
        let section = self.cache_section(system_setting);
        let mut ttl = section.ttl;
        let explicit_system_ttl = matches!(system_setting, Some(crate::models::CacheSectionSetting::Ttl(_)));
        if ttl.is_some() && !explicit_system_ttl {
            let tools_point = tool_config
                .and_then(|config| config.get("tools"))
                .and_then(JsonValue::as_array)
                .and_then(|tools| tools.iter().find_map(|tool| tool.get("cachePoint")));
            if tools_point.is_some_and(|point| point.get("ttl").and_then(JsonValue::as_str) != ttl.as_deref()) {
                ttl = None;
            }
        }
        for point in system.iter_mut().filter_map(|block| block.get_mut("cachePoint")) {
            let Some(point) = point.as_object_mut() else {
                continue;
            };
            let has_ttl = point
                .get("ttl")
                .and_then(JsonValue::as_str)
                .is_some_and(|ttl| !ttl.is_empty());
            if has_ttl {
                continue;
            }
            point.remove("ttl");
            if let Some(ttl) = &ttl {
                point.insert("ttl".to_owned(), json!(ttl));
            }
        }
    }

    /// Formats the messages, dropping reasoning the model rejects, wrapping the latest user input
    /// in guard content when configured, and placing the messages cache point.
    /// Formats the messages; `system_cache_points` is how many cache points the system prompt
    /// carries, which Nova's conversation points must fit beside.
    fn format_messages(
        &self,
        messages: &[Message],
        dynamic_trailing_blocks: usize,
        system_cache_points: usize,
    ) -> Result<Vec<JsonValue>> {
        let guard_latest = self
            .config
            .guardrail_config
            .as_ref()
            .and_then(|guardrail| guardrail.guard_latest_user_message)
            == Some(true);
        let last_user_text = guard_latest
            .then(|| find_last_user_text_message_index(messages))
            .flatten();
        let mut dropped_reasoning = false;
        let mut formatted = Vec::with_capacity(messages.len());
        for (index, message) in messages.iter().enumerate() {
            let mut content = Vec::with_capacity(message.content.len());
            for block in &message.content {
                if let ContentBlock::Reasoning(reasoning) = block
                    && self.rejects_reasoning_block(reasoning)
                {
                    dropped_reasoning = true;
                    continue;
                }
                let Some(block) = self.format_content_block(block)? else {
                    continue;
                };
                content.push(if Some(index) == last_user_text {
                    apply_guard_block(block)
                } else {
                    block
                });
            }
            if !content.is_empty() {
                formatted.push(json!({"role": role_str(message.role), "content": content}));
            }
        }
        if dropped_reasoning {
            tracing::debug!(
                "model_id=<{}> | dropped reasoningContent blocks the model does not accept",
                self.model_id()
            );
        }
        if self.should_enable_caching() {
            let messages_ttl = self
                .config
                .cache_config
                .as_ref()
                .and_then(|cache| cache.messages_ttl.as_ref());
            let section = self.cache_section(messages_ttl);
            if section.enabled {
                inject_cache_point(
                    &mut formatted,
                    section.ttl.as_deref(),
                    dynamic_trailing_blocks,
                    self.cache_point_rules(system_cache_points),
                );
            }
        }
        Ok(formatted)
    }

    /// Whether the configured model would reject this replayed reasoning block. Only blocks certain to
    /// fail are dropped: the signature is Anthropic-only, some models reject reasoning text outright,
    /// DeepSeek rejects any reasoning, and an ARN or bare profile id that names no vendor keeps
    /// everything.
    fn rejects_reasoning_block(&self, block: &ReasoningBlock) -> bool {
        let model_id = self.model_id().to_lowercase();
        if model_id.contains("deepseek") {
            return true;
        }
        if block.text.is_none() && block.signature.is_none() {
            return false;
        }
        let signed = block
            .signature
            .as_deref()
            .is_some_and(|signature| !signature.is_empty());
        if model_id.contains("anthropic") || model_id.contains("claude") {
            return !signed;
        }
        if model_id.starts_with("arn:") || !model_id.contains('.') {
            return false;
        }
        if MODELS_REJECT_REASONING_TEXT
            .iter()
            .any(|model| model_id.contains(model))
        {
            return true;
        }
        signed
    }

    /// Whether tool results carry their status.
    fn should_include_tool_result_status(&self) -> bool {
        match self.config.include_tool_result_status.unwrap_or_default() {
            IncludeToolResultStatus::Enabled(enabled) => enabled,
            IncludeToolResultStatus::Auto => {
                let model_id = self.config.model_id.as_deref().unwrap_or_default();
                let include = MODELS_INCLUDE_STATUS.iter().any(|pattern| model_id.contains(pattern));
                tracing::debug!(
                    "model_id=<{model_id}>, include_tool_result_status=<{include}> | auto-detected includeToolResultStatus"
                );
                include
            }
        }
    }

    /// Formats a content block, `None` for blocks Bedrock is not sent.
    fn format_content_block(&self, block: &ContentBlock) -> Result<Option<JsonValue>> {
        let formatted = match block {
            ContentBlock::Text(text) => json!({"text": text.text}),
            ContentBlock::ToolUse(tool_use) => json!({
                "toolUse": {"toolUseId": tool_use.tool_use_id, "name": tool_use.name, "input": tool_use.input}
            }),
            ContentBlock::ToolResult(result) => self.format_tool_result(result)?,
            ContentBlock::Reasoning(reasoning) => format_reasoning(reasoning)?,
            ContentBlock::CachePoint(point) => json!({"cachePoint": format_cache_point(point)}),
            ContentBlock::Audio(audio) => {
                json!({"audio": media(json!(audio.format), format_audio_source(&audio.source))})
            }
            ContentBlock::Image(image) => format_image(image),
            ContentBlock::Video(video) => format_video(video),
            ContentBlock::Document(document) => format_document(document),
            ContentBlock::Citations(citations) => format_citations(citations),
            ContentBlock::GuardContent(guard) => json!({"guardContent": format_guard_content(guard)}),
            ContentBlock::Injected(_) => {
                // ModelProxy turns the ones Bedrock should see into text, so only a direct call or
                // a model info override that turns temporary messages on gets here.
                warn_once("block_type=<injectedBlock> | bedrock does not send injected blocks | skipping it");
                return Ok(None);
            }
            ContentBlock::Summary(_) => return Err(invalid("content_type=<summaryBlock> | unsupported type")),
            _ => return Ok(None),
        };
        Ok(Some(formatted))
    }

    fn format_tool_result(&self, result: &ToolResultBlock) -> Result<JsonValue> {
        let content: Vec<JsonValue> = result
            .content
            .iter()
            .filter_map(|content| match content {
                ToolResultContent::Text(text) => Some(json!({"text": text.text})),
                ToolResultContent::Json(json) => Some(json!({"json": json.json})),
                ToolResultContent::Image(image) => Some(format_image(image)),
                ToolResultContent::Video(video) => Some(format_video(video)),
                ToolResultContent::Document(document) => Some(format_document(document)),
                _ => None,
            })
            .collect();
        let mut tool_result = JsonObject::new();
        tool_result.insert("toolUseId".to_owned(), json!(result.tool_use_id));
        tool_result.insert("content".to_owned(), JsonValue::Array(content));
        if self.should_include_tool_result_status() {
            tool_result.insert("status".to_owned(), json!(result.status));
        }
        Ok(json!({"toolResult": tool_result}))
    }
}

fn role_str(role: Role) -> &'static str {
    match role {
        Role::User => "user",
        Role::Assistant => "assistant",
    }
}

fn format_system_block(block: &SystemContentBlock) -> Result<JsonValue> {
    match block {
        SystemContentBlock::Text(text) => Ok(json!({"text": text.text})),
        SystemContentBlock::CachePoint(point) => Ok(json!({"cachePoint": format_cache_point(point)})),
        SystemContentBlock::GuardContent(guard) => Ok(json!({"guardContent": format_guard_content(guard)})),
    }
}

fn format_tool_spec(spec: &ToolSpec, strict_tools: bool) -> JsonValue {
    let schema = match &spec.input_schema {
        Some(schema) if strict_tools => Some(to_strict_input_schema(&spec.name, schema)),
        schema => schema.clone(),
    };
    let mut tool_spec = JsonObject::new();
    tool_spec.insert("name".to_owned(), json!(spec.name));
    tool_spec.insert("description".to_owned(), json!(spec.description));
    let mut input_schema = JsonObject::new();
    if let Some(schema) = schema {
        input_schema.insert("json".to_owned(), schema);
    }
    tool_spec.insert("inputSchema".to_owned(), JsonValue::Object(input_schema));
    if strict_tools {
        tool_spec.insert("strict".to_owned(), json!(true));
    }
    json!({"toolSpec": tool_spec})
}

/// The strict-mode copy of a tool's input schema, warning once per tool when it still uses
/// keywords Bedrock's strict mode rejects.
fn to_strict_input_schema(tool_name: &str, input_schema: &JsonSchema) -> JsonSchema {
    let strict = ensure_strict_json_schema(input_schema);
    let unsupported = find_unsupported_strict_keywords(&strict);
    if !unsupported.is_empty() {
        warn_once(&format!(
            "tool=<{tool_name}>, keywords=<{}> | tool schema uses keywords bedrock strict mode rejects, request may fail",
            unsupported.join(",")
        ));
    }
    strict
}

fn cache_point(ttl: Option<&str>) -> JsonValue {
    let mut point = JsonObject::new();
    point.insert("type".to_owned(), json!("default"));
    if let Some(ttl) = ttl.filter(|ttl| !ttl.is_empty()) {
        point.insert("ttl".to_owned(), json!(ttl));
    }
    JsonValue::Object(point)
}

fn format_cache_point(point: &crate::types::CachePointBlock) -> JsonValue {
    let mut formatted = JsonObject::new();
    formatted.insert("type".to_owned(), json!(point.cache_type));
    if let Some(ttl) = point.ttl.as_deref().filter(|ttl| !ttl.is_empty()) {
        formatted.insert("ttl".to_owned(), json!(ttl));
    }
    JsonValue::Object(formatted)
}

fn format_reasoning(block: &ReasoningBlock) -> Result<JsonValue> {
    if block.text.is_some() || block.signature.is_some() {
        let mut text = JsonObject::new();
        text.insert("text".to_owned(), json!(block.text.as_deref().unwrap_or_default()));
        if let Some(signature) = &block.signature {
            text.insert("signature".to_owned(), json!(signature));
        }
        return Ok(json!({"reasoningContent": {"reasoningText": text}}));
    }
    if let Some(redacted) = &block.redacted_content {
        return Ok(json!({"reasoningContent": {"redactedContent": bytes(redacted)}}));
    }
    Err(invalid(
        "reasoning content requires one of 'text', 'signature', or 'redactedContent' to be set",
    ))
}

/// A media block body: the format, and the source when Bedrock can take it.
fn media(format: JsonValue, source: Option<JsonValue>) -> JsonValue {
    let mut body = JsonObject::new();
    body.insert("format".to_owned(), format);
    if let Some(source) = source {
        body.insert("source".to_owned(), source);
    }
    JsonValue::Object(body)
}

fn s3_location(location: &S3Location) -> JsonValue {
    let mut formatted = JsonObject::new();
    formatted.insert("uri".to_owned(), json!(location.uri));
    if let Some(owner) = location.bucket_owner.as_deref().filter(|owner| !owner.is_empty()) {
        formatted.insert("bucketOwner".to_owned(), json!(owner));
    }
    json!({"s3Location": formatted})
}

fn format_audio_source(source: &AudioSource) -> Option<JsonValue> {
    match source {
        AudioSource::Bytes(data) => Some(json!({"bytes": bytes(data)})),
        AudioSource::Location(location) => Some(s3_location(location)),
    }
}

fn format_image_source(source: &ImageSource) -> Option<JsonValue> {
    match source {
        ImageSource::Bytes(data) => Some(json!({"bytes": bytes(data)})),
        ImageSource::Location(location) => Some(s3_location(location)),
        ImageSource::Url(url) if url.starts_with("s3://") => Some(json!({"s3Location": {"uri": url}})),
        _ => {
            tracing::warn!("source_type=<imageSourceUrl> | not supported by bedrock | skipping");
            None
        }
    }
}

fn format_video_source(source: &VideoSource) -> Option<JsonValue> {
    match source {
        VideoSource::Bytes(data) => Some(json!({"bytes": bytes(data)})),
        VideoSource::Location(location) => Some(s3_location(location)),
    }
}

fn format_image(image: &crate::types::ImageBlock) -> JsonValue {
    json!({"image": media(json!(image.format), format_image_source(&image.source))})
}

fn format_video(video: &crate::types::VideoBlock) -> JsonValue {
    let format = match video.format {
        VideoFormat::ThreeGp => json!("three_gp"),
        format => json!(format),
    };
    json!({"video": media(format, format_video_source(&video.source))})
}

fn format_document_source(source: &DocumentSource) -> JsonValue {
    match source {
        DocumentSource::Bytes(data) => json!({"bytes": bytes(data)}),
        // Bedrock takes bytes, content or an S3 location, so text is sent as its UTF-8 bytes.
        DocumentSource::Text(text) => json!({"bytes": bytes(text.as_bytes())}),
        DocumentSource::Content(blocks) => {
            json!({"content": blocks.iter().map(|block| json!({"text": block.text})).collect::<Vec<_>>()})
        }
        DocumentSource::Location(location) => s3_location(location),
    }
}

fn format_document(document: &DocumentBlock) -> JsonValue {
    let mut body = JsonObject::new();
    body.insert("name".to_owned(), json!(document.name));
    body.insert("format".to_owned(), json!(document.format));
    body.insert("source".to_owned(), format_document_source(&document.source));
    if let Some(citations) = &document.citations {
        body.insert("citations".to_owned(), json!({"enabled": citations.enabled}));
    }
    if let Some(context) = document.context.as_deref().filter(|context| !context.is_empty()) {
        body.insert("context".to_owned(), json!(context));
    }
    json!({"document": body})
}

fn format_citations(block: &CitationsBlock) -> JsonValue {
    let citations: Vec<JsonValue> = block.citations.iter().map(format_citation).collect();
    let content: Vec<JsonValue> = block.content.iter().map(|item| json!({"text": item.text})).collect();
    json!({"citationsContent": {"citations": citations, "content": content}})
}

/// Maps a citation to Bedrock's shape.
fn format_citation(citation: &Citation) -> JsonValue {
    let mut formatted = JsonObject::new();
    formatted.insert("location".to_owned(), format_citation_location(&citation.location));
    let source_content: Vec<JsonValue> = citation
        .source_content
        .iter()
        .map(|item| json!({"text": item.text}))
        .collect();
    formatted.insert("sourceContent".to_owned(), JsonValue::Array(source_content));
    // An empty source marks one Bedrock never returned (document citations); Bedrock rejects
    // `source` on those locations while requiring it on search-result locations.
    if !citation.source.is_empty() {
        formatted.insert("source".to_owned(), json!(citation.source));
    }
    formatted.insert("title".to_owned(), json!(citation.title));
    JsonValue::Object(formatted)
}

/// Maps a citation location to Bedrock's object-key form.
fn format_citation_location(location: &CitationLocation) -> JsonValue {
    let range = |index_key: &str, index: u64, start: u64, end: u64| {
        let mut fields = JsonObject::new();
        fields.insert(index_key.to_owned(), json!(index));
        fields.insert("start".to_owned(), json!(start));
        fields.insert("end".to_owned(), json!(end));
        JsonValue::Object(fields)
    };
    match location {
        CitationLocation::DocumentChar(loc) => {
            json!({"documentChar": range("documentIndex", loc.document_index, loc.start, loc.end)})
        }
        CitationLocation::DocumentPage(loc) => {
            json!({"documentPage": range("documentIndex", loc.document_index, loc.start, loc.end)})
        }
        CitationLocation::DocumentChunk(loc) => {
            json!({"documentChunk": range("documentIndex", loc.document_index, loc.start, loc.end)})
        }
        CitationLocation::SearchResult(loc) => {
            json!({"searchResultLocation": range("searchResultIndex", loc.search_result_index, loc.start, loc.end)})
        }
        CitationLocation::Web(loc) => {
            let mut web = JsonObject::new();
            web.insert("url".to_owned(), json!(loc.url));
            if let Some(domain) = loc.domain.as_deref().filter(|domain| !domain.is_empty()) {
                web.insert("domain".to_owned(), json!(domain));
            }
            json!({"web": web})
        }
    }
}

fn format_guard_content(guard: &GuardContentBlock) -> JsonValue {
    match guard {
        GuardContentBlock::Image(image) => json!({
            "image": {"format": image.format, "source": {"bytes": bytes(&image.source.bytes)}}
        }),
        GuardContentBlock::Text(text) => json!({"text": {"text": text.text, "qualifiers": text.qualifiers}}),
    }
}

/// Wraps a formatted text or image block in guard content, so guardrails evaluate only that
/// content. Other blocks pass through.
fn apply_guard_block(block: JsonValue) -> JsonValue {
    if let Some(text) = block.get("text") {
        return json!({"guardContent": {"text": {"text": text}}});
    }
    let Some(image) = block.get("image") else {
        return block;
    };
    let (Some(format), Some(source)) = (image.get("format").and_then(JsonValue::as_str), image.get("source")) else {
        return block;
    };
    if format != "png" && format != "jpeg" {
        tracing::warn!(
            "image_format=<{format}> | format not supported by bedrock guardrails | skipping guardContent wrap"
        );
        return block;
    }
    if source.get("bytes").is_none() {
        tracing::warn!(
            "source_type=<non-bytes> | image source must be bytes for bedrock guardrails | skipping guardContent wrap"
        );
        return block;
    }
    json!({"guardContent": {"image": {"format": format, "source": source}}})
}

/// The last user message with text or image content, so tool
/// result turns after the user's input do not move the guard target.
fn find_last_user_text_message_index(messages: &[Message]) -> Option<usize> {
    messages.iter().rposition(|message| {
        message.role == Role::User
            && message
                .content
                .iter()
                .any(|block| matches!(block, ContentBlock::Text(_) | ContentBlock::Image(_)))
    })
}

fn is_cache_point(block: &JsonValue) -> bool {
    block.get("cachePoint").is_some()
}

fn is_non_pdf_document(block: &JsonValue) -> bool {
    block
        .get("document")
        .is_some_and(|document| document.get("format").and_then(JsonValue::as_str) != Some("pdf"))
}

fn content_mut(message: &mut JsonValue) -> Option<&mut Vec<JsonValue>> {
    message.get_mut("content").and_then(JsonValue::as_array_mut)
}

/// Converse rejects a request with more cache points than this.
const MAX_CACHE_POINTS: usize = 4;

/// With one point on the system prompt, that is the four Converse accepts.
const NOVA_CONVERSATION_CACHE_POINTS: usize = 3;

/// Where the model takes cache points.
#[derive(Clone, Copy)]
struct CachePointRules<'a> {
    /// The model takes a cache point only directly after text (Nova).
    after_text_only: bool,
    model_id: &'a str,
    /// The most conversation points a model that takes them only after text gets, so the request
    /// stays within [`MAX_CACHE_POINTS`] beside the system prompt's.
    conversation_points: usize,
}

/// Steps a cache point index back over the adjacent run of non-PDF documents directly ahead of
/// it. Bedrock rejects a cache point directly after one; moving further would evict durable
/// content, usually the document itself, from the cached prefix.
fn step_back_over_documents(content: &[JsonValue], index: usize) -> usize {
    let mut target = index;
    while target > 0 && is_non_pdf_document(&content[target - 1]) {
        target -= 1;
    }
    target
}

/// Steps a cache point index back to directly after the nearest text block ahead of it, or 0
/// when no text block precedes it.
fn step_back_to_text(content: &[JsonValue], index: usize) -> usize {
    (1..=index)
        .rev()
        .find(|target| content[target - 1].get("text").is_some())
        .unwrap_or(0)
}

/// Keeps a caller-placed cache point with the configured TTL and the placement rules. Returns
/// `false` when nothing cacheable precedes it (or, on a model that takes a cache point only after
/// text, no text does), so it was removed: Bedrock rejects a cache point with no content ahead of
/// it.
fn honor_placed_cache_point(
    content: &mut Vec<JsonValue>,
    placed_index: usize,
    message_index: usize,
    ttl: Option<&str>,
    rules: CachePointRules<'_>,
) -> bool {
    if content.get(placed_index).is_none_or(|block| !is_cache_point(block)) {
        return false;
    }
    if placed_index == 0 {
        content.remove(0);
        tracing::warn!(
            "msg_idx=<{message_index}> | removed cache point with no content ahead of it, falling back to automatic placement"
        );
        return false;
    }
    // The caller's position is honored, not their TTL: Bedrock rejects a longer TTL after a
    // shorter one across tools, system and messages.
    let mut placed = content.remove(placed_index);
    if let Some(point) = placed.get_mut("cachePoint").and_then(JsonValue::as_object_mut) {
        point.remove("ttl");
        if let Some(ttl) = ttl.filter(|ttl| !ttl.is_empty()) {
            point.insert("ttl".to_owned(), json!(ttl));
        }
    }
    let target = if rules.after_text_only {
        step_back_to_text(content, placed_index)
    } else {
        step_back_over_documents(content, placed_index)
    };
    if target == placed_index {
        content.insert(placed_index, placed);
        tracing::debug!("msg_idx=<{message_index}>, block_idx=<{placed_index}> | honored caller-placed cache point");
        return true;
    }
    if target == 0 && rules.after_text_only {
        warn_once(&format!(
            "model_id=<{}> | dropped a caller-placed cache point with no text ahead of it, this model takes one only directly after text, placing it automatically instead",
            rules.model_id
        ));
        return false;
    }
    if target == 0 {
        tracing::warn!("msg_idx=<{message_index}> | dropped cache point ahead of a leading document");
        return false;
    }
    content.insert(target, placed);
    tracing::debug!("msg_idx=<{message_index}>, block_idx=<{target}> | relocated caller-placed cache point");
    true
}

/// Leaves exactly one cache point in the last user message, honoring one the caller placed
/// there, and strips cache points from every other message. A model that takes cache points only
/// after text instead gets one on each of its last few user messages with text (see
/// [`nova_cache_point_positions`]).
fn inject_cache_point(
    messages: &mut [JsonValue],
    ttl: Option<&str>,
    dynamic_trailing_blocks: usize,
    rules: CachePointRules<'_>,
) {
    let last_user = messages
        .iter()
        .rposition(|message| message.get("role").and_then(JsonValue::as_str) == Some("user"));
    for (message_index, message) in messages.iter_mut().enumerate() {
        if Some(message_index) == last_user {
            continue;
        }
        let Some(content) = content_mut(message) else {
            continue;
        };
        for block_index in (0..content.len()).rev() {
            if is_cache_point(&content[block_index]) {
                content.remove(block_index);
                tracing::warn!(
                    "msg_idx=<{message_index}>, block_idx=<{block_index}> | stripped existing cache point (auto mode manages cache points)"
                );
            }
        }
    }
    if let Some(last_user) = last_user {
        place_last_user_cache_point(messages, last_user, ttl, dynamic_trailing_blocks, rules);
    }
}

fn place_last_user_cache_point(
    messages: &mut [JsonValue],
    message_index: usize,
    ttl: Option<&str>,
    dynamic_trailing_blocks: usize,
    rules: CachePointRules<'_>,
) {
    let Some(content) = content_mut(&mut messages[message_index]) else {
        return;
    };
    // Blocks after the caller's boundary are per-call content, so a fallback point never lands
    // among them.
    let mut trailing_blocks = dynamic_trailing_blocks;
    let placed: Vec<usize> = (0..content.len())
        .filter(|index| is_cache_point(&content[*index]))
        .collect();
    if let Some((&first, extras)) = placed.split_first() {
        // One boundary per message, within Bedrock's four cache points per request shared with
        // the tools and system points. Descending, so each removal is above the indexes still used.
        for &extra in extras.iter().rev() {
            content.remove(extra);
            tracing::warn!(
                "msg_idx=<{message_index}>, block_idx=<{extra}> | stripped existing cache point (auto mode manages cache points)"
            );
        }
        if rules.after_text_only && rules.conversation_points == 0 {
            content.remove(first);
            tracing::warn!(
                "msg_idx=<{message_index}>, block_idx=<{first}> | no cache point left after the system prompt | dropped caller-placed cache point"
            );
            return;
        }
        if honor_placed_cache_point(content, first, message_index, ttl, rules) {
            if rules.after_text_only && message_index > 0 {
                // The caller's point is the newest one, so the rest go on the user messages before it.
                inject_nova_cache_points(messages, message_index - 1, 0, rules.conversation_points - 1);
            }
            return;
        }
        trailing_blocks = trailing_blocks.max(content.len().saturating_sub(first));
        if content.is_empty() {
            tracing::debug!("msg_idx=<{message_index}> | no content left to cache");
            return;
        }
    }
    if rules.after_text_only {
        inject_nova_cache_points(messages, message_index, trailing_blocks, rules.conversation_points);
        return;
    }
    let Some(content) = content_mut(&mut messages[message_index]) else {
        return;
    };
    let point = json!({"cachePoint": cache_point(ttl)});
    if dynamic_trailing_blocks > 0 {
        // Per-call content sits at the end, so the reusable prefix ends where it begins; the honor
        // path applies the document rule and the TTL.
        let boundary = content.len().saturating_sub(dynamic_trailing_blocks);
        if boundary == 0 {
            tracing::debug!("msg_idx=<{message_index}> | skipped cache point, no durable prefix");
            return;
        }
        content.insert(boundary, point);
        honor_placed_cache_point(content, boundary, message_index, ttl, rules);
        return;
    }
    match content.iter().position(is_non_pdf_document) {
        None => content.push(point),
        Some(0) => {
            // A leading non-PDF document leaves no prefix to cache and Bedrock rejects it.
            tracing::debug!("msg_idx=<{message_index}> | skipped cache point for leading non-PDF document");
            return;
        }
        Some(index) => content.insert(index, point),
    }
    tracing::debug!("msg_idx=<{message_index}> | added cache point to last user message");
}

/// Where the Nova conversation cache points go, newest first: directly after the last text block
/// of each of the last `count` user messages that have one, ahead of the final message's per-call
/// blocks. Nova takes a cache point only directly after text and reads an entry only at a position
/// an earlier call marked too, so the points on earlier turns are what let a new turn read. More
/// than one of them helps on a cross-region inference profile, where a call only finds entries
/// written in the region that serves it. In a tool loop, whose user messages hold tool results, the
/// points stay where they are.
fn nova_cache_point_positions(
    messages: &[JsonValue],
    last_user: usize,
    dynamic_trailing_blocks: usize,
    count: usize,
) -> Vec<(usize, usize)> {
    (0..=last_user)
        .rev()
        .filter_map(|message_index| {
            let message = &messages[message_index];
            if message.get("role").and_then(JsonValue::as_str) != Some("user") {
                return None;
            }
            let content = message
                .get("content")
                .and_then(JsonValue::as_array)
                .map_or(&[][..], Vec::as_slice);
            let end = if message_index == last_user {
                content.len().saturating_sub(dynamic_trailing_blocks)
            } else {
                content.len()
            };
            let block_index = step_back_to_text(content, end);
            (block_index > 0).then_some((message_index, block_index))
        })
        .take(count)
        .collect()
}

/// Places the Nova conversation cache points, which take no TTL, at
/// [`nova_cache_point_positions`].
fn inject_nova_cache_points(
    messages: &mut [JsonValue],
    last_user: usize,
    dynamic_trailing_blocks: usize,
    count: usize,
) {
    let positions = nova_cache_point_positions(messages, last_user, dynamic_trailing_blocks, count);
    if positions.is_empty() {
        tracing::debug!("no user text to follow or no cache point left, skipped conversation cache point");
    }
    for (message_index, block_index) in positions {
        if let Some(content) = content_mut(&mut messages[message_index]) {
            content.insert(block_index, json!({"cachePoint": {"type": "default"}}));
        }
        tracing::debug!("msg_idx=<{message_index}>, block_idx=<{block_index}> | added cache point after text");
    }
}

/// The Converse `outputConfig` constraining the response to the schema, merged into the request's
/// existing output config.
pub(super) fn apply_native_output_config(request: &mut JsonObject, schema: &JsonValue) -> Result<()> {
    let native = to_native_output_schema(schema)?;
    let text_format = json!({
        "type": "json_schema",
        "structure": {"jsonSchema": {"schema": serde_json::to_string(&native)?, "name": STRUCTURED_OUTPUT_TOOL_NAME}}
    });
    let output_config = request
        .entry("outputConfig".to_owned())
        .or_insert_with(|| JsonValue::Object(JsonObject::new()));
    match output_config.as_object_mut() {
        Some(config) => {
            config.insert("textFormat".to_owned(), text_format);
        }
        None => *output_config = json!({"textFormat": text_format}),
    }
    Ok(())
}

/// The request with stale thinking blocks dropped (`drop_block` and its beta), or `None` if it
/// cannot change.
pub(super) fn request_with_drop_block(request: &JsonObject) -> Option<JsonObject> {
    let empty = JsonObject::new();
    let fields = match request.get("additionalModelRequestFields") {
        Some(fields) => fields.as_object()?,
        None => &empty,
    };
    let tool_forced = request
        .get("toolConfig")
        .and_then(|config| config.get("toolChoice"))
        .and_then(JsonValue::as_object)
        .is_some_and(|choice| choice.contains_key("any") || choice.contains_key("tool"));
    let thinking = thinking_with_drop_block(fields.get("thinking"), tool_forced)?;
    let mut betas: Vec<JsonValue> = fields
        .get("anthropic_beta")
        .and_then(JsonValue::as_array)
        .cloned()
        .unwrap_or_default();
    if !betas.iter().any(|beta| beta.as_str() == Some(THINKING_BINDING_BETA)) {
        betas.push(json!(THINKING_BINDING_BETA));
    }
    let mut updated = fields.clone();
    updated.insert("anthropic_beta".to_owned(), JsonValue::Array(betas));
    updated.insert("thinking".to_owned(), JsonValue::Object(thinking));
    let mut request = request.clone();
    request.insert("additionalModelRequestFields".to_owned(), JsonValue::Object(updated));
    Some(request)
}
