//! Offload targets: which blocks and messages a strategy acts on.

use std::collections::{HashMap, HashSet};

use crate::error::{Error, Result};
use crate::types::{ContentBlock, Message, Role, ToolResultBlock, ToolResultContent, ToolResultStatus};

/// What an offload strategy acts on (`OffloadTarget`).
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum OffloadTarget {
    /// Whole messages (`'*'`).
    All,
    /// Successful tool results (`'toolResults'`).
    ToolResults,
    /// Failed tool results (`'toolResultErrors'`).
    ToolResultErrors,
    /// Text blocks of assistant messages (`'assistantText'`).
    AssistantText,
    /// Text blocks of user messages, tool results excluded (`'userText'`).
    UserText,
    /// Image, document, video and audio blocks outside tool results (`'media'`).
    Media,
    /// Results of the named tools (`bash` or `tool::bash`); a leading `!` excludes a tool instead.
    /// A list of only exclusions acts on every other tool.
    Tools(Vec<String>),
}

impl OffloadTarget {
    /// The results of the named tools (`['tool::bash', '!tool::read']`).
    pub fn tools(tools: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self::Tools(tools.into_iter().map(Into::into).collect())
    }
}

const TOOL_PREFIX: &str = "tool::";

/// The media kind of a block, such as `image`, for markers, or `None` when it is not media
/// (`mediaKind`).
pub(crate) fn media_kind(block: &ContentBlock) -> Option<&'static str> {
    match block {
        ContentBlock::Image(_) => Some("image"),
        ContentBlock::Document(_) => Some("document"),
        ContentBlock::Video(_) => Some("video"),
        ContentBlock::Audio(_) => Some("audio"),
        _ => None,
    }
}

/// A block's type name for logs, such as `textBlock` (`block.type`).
pub(crate) fn block_type(block: &ContentBlock) -> &'static str {
    match block {
        ContentBlock::Text(_) => "textBlock",
        ContentBlock::ToolUse(_) => "toolUseBlock",
        ContentBlock::ToolResult(_) => "toolResultBlock",
        ContentBlock::Reasoning(_) => "reasoningBlock",
        ContentBlock::CachePoint(_) => "cachePointBlock",
        ContentBlock::GuardContent(_) => "guardContentBlock",
        ContentBlock::Audio(_) => "audioBlock",
        ContentBlock::Image(_) => "imageBlock",
        ContentBlock::Video(_) => "videoBlock",
        ContentBlock::Document(_) => "documentBlock",
        ContentBlock::Citations(_) => "citationsBlock",
        ContentBlock::Injected(_) => "injectedBlock",
        ContentBlock::Summary(_) => "summaryBlock",
        _ => "unknownBlock",
    }
}

/// The target as JSON, as a log names it: `"toolResults"`, or `["bash"]` for a tool list.
pub(crate) fn target_json(target: &OffloadTarget) -> String {
    let name = match target {
        OffloadTarget::Tools(entries) => return serde_json::to_string(entries).unwrap_or_default(),
        OffloadTarget::All => "*",
        OffloadTarget::ToolResults => "toolResults",
        OffloadTarget::ToolResultErrors => "toolResultErrors",
        OffloadTarget::AssistantText => "assistantText",
        OffloadTarget::UserText => "userText",
        OffloadTarget::Media => "media",
    };
    format!("\"{name}\"")
}

/// Whether a block is an image, document, video or audio block (`isMediaBlock`).
pub(crate) fn is_media_block(block: &ContentBlock) -> bool {
    media_kind(block).is_some()
}

/// Whether tool result content is an image, document or video.
pub(crate) fn is_media_content(content: &ToolResultContent) -> bool {
    matches!(
        content,
        ToolResultContent::Image(_) | ToolResultContent::Document(_) | ToolResultContent::Video(_)
    )
}

/// Whether a block is protocol rather than content: tool uses, cache points and reasoning are
/// never stored or offloaded (`isProtocolBlock`).
pub(crate) fn is_protocol_block(block: &ContentBlock) -> bool {
    matches!(
        block,
        ContentBlock::ToolUse(_) | ContentBlock::CachePoint(_) | ContentBlock::Reasoning(_)
    )
}

/// `toolUseId` to tool name, from every assistant tool use (`buildToolNameMap`).
pub(crate) fn build_tool_name_map(messages: &[Message]) -> HashMap<String, String> {
    messages
        .iter()
        .filter(|message| message.role == Role::Assistant)
        .flat_map(|message| &message.content)
        .filter_map(|block| match block {
            ContentBlock::ToolUse(tool_use) => Some((tool_use.tool_use_id.clone(), tool_use.name.clone())),
            _ => None,
        })
        .collect()
}

/// Matches blocks and messages against an [`OffloadTarget`]; a tool list's names are parsed once,
/// here (`OffloadTargetMatcher`).
#[derive(Debug, Clone)]
pub(crate) struct OffloadTargetMatcher {
    pub(crate) target: OffloadTarget,
    include: Option<HashSet<String>>,
    exclude: Option<HashSet<String>>,
}

impl OffloadTargetMatcher {
    /// # Errors
    ///
    /// An empty tool list, or one that excludes every tool it includes.
    pub(crate) fn new(target: OffloadTarget) -> Result<Self> {
        let (include, exclude) = match &target {
            OffloadTarget::Tools(entries) if entries.is_empty() => {
                return Err(Error::other(
                    "Empty array target matches nothing — provide at least one target",
                ));
            }
            OffloadTarget::Tools(entries) => resolve_tool_filter(entries),
            _ => (None, None),
        };
        if let (Some(include), OffloadTarget::Tools(entries)) = (&include, &target)
            && include.is_empty()
        {
            return Err(Error::other(format!(
                "Tool target {} excludes every tool it includes, so it matches nothing",
                serde_json::to_string(entries).unwrap_or_default()
            )));
        }
        Ok(Self {
            target,
            include,
            exclude,
        })
    }

    /// Whether every kind of block is in scope.
    pub(crate) fn matches_all(&self) -> bool {
        self.target == OffloadTarget::All
    }

    /// Whether a block in `message` is one this target covers. A placeholder matches like the text
    /// block it is, so callers that must not re-offload one filter it out first.
    pub(crate) fn matches_block(
        &self,
        block: &ContentBlock,
        message: &Message,
        tool_names: &HashMap<String, String>,
    ) -> bool {
        if self.matches_all() {
            return true;
        }
        match block {
            ContentBlock::Text(_) => self.matches_text(message),
            ContentBlock::ToolResult(result) => self.matches_tool_result(result, tool_names),
            other => self.target == OffloadTarget::Media && is_media_block(other),
        }
    }

    /// Whether a message holds anything this target covers.
    pub(crate) fn matches_message(&self, message: &Message, tool_names: &HashMap<String, String>) -> bool {
        self.matches_all()
            || message
                .content
                .iter()
                .any(|block| self.matches_block(block, message, tool_names))
    }

    fn matches_text(&self, message: &Message) -> bool {
        match self.target {
            OffloadTarget::AssistantText => message.role == Role::Assistant,
            OffloadTarget::UserText => message.role == Role::User,
            _ => false,
        }
    }

    fn matches_tool_result(&self, block: &ToolResultBlock, tool_names: &HashMap<String, String>) -> bool {
        match self.target {
            OffloadTarget::ToolResults => return block.status == ToolResultStatus::Success,
            OffloadTarget::ToolResultErrors => return block.status == ToolResultStatus::Error,
            OffloadTarget::Tools(_) => {}
            _ => return false,
        }
        let Some(name) = tool_names.get(&block.tool_use_id).filter(|name| !name.is_empty()) else {
            return false;
        };
        if let Some(include) = &self.include {
            return include.contains(name);
        }
        self.exclude.as_ref().is_some_and(|exclude| !exclude.contains(name))
    }
}

/// A tool list's include and exclude sets. Entries may be prefixed with `tool::`; an extra leading
/// `!` excludes. A list with includes keeps the includes minus the excludes.
fn resolve_tool_filter(entries: &[String]) -> (Option<HashSet<String>>, Option<HashSet<String>>) {
    let mut includes = Vec::new();
    let mut excludes = HashSet::new();
    for entry in entries {
        let (excluded, name) = match entry.strip_prefix('!') {
            Some(name) => (true, name),
            None => (false, entry.as_str()),
        };
        let tool_name = name.strip_prefix(TOOL_PREFIX).unwrap_or(name).to_owned();
        if excluded {
            excludes.insert(tool_name);
        } else {
            includes.push(tool_name);
        }
    }
    if !includes.is_empty() {
        let include = includes.into_iter().filter(|name| !excludes.contains(name)).collect();
        return (Some(include), None);
    }
    if !excludes.is_empty() {
        return (None, Some(excludes));
    }
    (None, None)
}
