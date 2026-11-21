//! The stdout printer: text, reasoning and tool activity as an invocation streams.

use std::io::Write;

use crate::hooks::AgentStreamEvent;
use crate::models::streaming::{
    ContentBlockDelta, ContentBlockStart, ModelContentBlockDeltaEvent, ModelContentBlockStartEvent, ModelStreamEvent,
};
use crate::types::ToolResultStatus;

pub(crate) type Appender = Box<dyn FnMut(&str) + Send + Sync>;

/// Writes stdout and flushes, so streamed text shows as it arrives.
pub(crate) fn default_appender() -> Appender {
    Box::new(|text| {
        let mut stdout = std::io::stdout().lock();
        let _ = stdout.write_all(text.as_bytes());
        let _ = stdout.flush();
    })
}

/// Formats stream records for a human (`AgentPrinter`).
pub(crate) struct AgentPrinter {
    appender: Appender,
    in_reasoning_block: bool,
    tool_count: u64,
    need_reasoning_indent: bool,
}

impl AgentPrinter {
    pub(crate) fn new(appender: Appender) -> Self {
        Self {
            appender,
            in_reasoning_block: false,
            tool_count: 0,
            need_reasoning_indent: false,
        }
    }

    fn write(&mut self, content: &str) {
        (self.appender)(content);
    }

    /// Prints one record. `cancelled` is the hook decision of a
    /// `BeforeToolCallEvent` or `BeforeToolsEvent`, which records do not carry.
    pub(crate) fn process_event(&mut self, event: &AgentStreamEvent, cancelled: bool) {
        match event {
            AgentStreamEvent::ModelStreamUpdate(update) => self.handle_model_stream_event(&update.event),
            AgentStreamEvent::BeforeToolCall(call) => {
                self.tool_count += 1;
                let text = if cancelled {
                    format!("\n🚫 Tool #{}: {} (denied)\n", self.tool_count, call.tool_use.name)
                } else {
                    format!("\n🔧 Tool #{}: {}\n", self.tool_count, call.tool_use.name)
                };
                self.write(&text);
            }
            AgentStreamEvent::BeforeTools(_) if cancelled => self.write("\n🚫 All tools denied\n"),
            AgentStreamEvent::ToolResult(result) => match result.result.status {
                ToolResultStatus::Success => self.write("✓ Tool completed\n"),
                ToolResultStatus::Error => self.write("✗ Tool failed\n"),
            },
            AgentStreamEvent::AgentResult(_) => self.write("\n"),
            _ => {}
        }
    }

    fn handle_model_stream_event(&mut self, event: &ModelStreamEvent) {
        match event {
            ModelStreamEvent::ContentBlockDelta(delta) => self.handle_content_block_delta(delta),
            ModelStreamEvent::ContentBlockStart(start) => self.handle_content_block_start(start),
            ModelStreamEvent::ContentBlockStop(_) => self.handle_content_block_stop(),
            _ => {}
        }
    }

    fn handle_content_block_delta(&mut self, event: &ModelContentBlockDeltaEvent) {
        match &event.delta {
            ContentBlockDelta::Text(delta) if !delta.text.is_empty() => {
                let text = delta.text.clone();
                self.write(&text);
            }
            ContentBlockDelta::ReasoningContent(delta) => {
                if !self.in_reasoning_block {
                    self.in_reasoning_block = true;
                    self.need_reasoning_indent = true;
                    self.write("\n💭 Reasoning:\n");
                }
                if let Some(text) = delta.text.as_deref().filter(|text| !text.is_empty()) {
                    let text = text.to_owned();
                    self.write_reasoning_text(&text);
                }
            }
            _ => {}
        }
    }

    fn write_reasoning_text(&mut self, text: &str) {
        let mut output = String::with_capacity(text.len());
        for char in text.chars() {
            if self.need_reasoning_indent && char != '\n' {
                output.push_str("   ");
                self.need_reasoning_indent = false;
            }
            output.push(char);
            if char == '\n' {
                self.need_reasoning_indent = true;
            }
        }
        self.write(&output);
    }

    fn handle_content_block_start(&mut self, event: &ModelContentBlockStartEvent) {
        if let Some(ContentBlockStart::ToolUse(start)) = &event.start {
            let text = format!("\n  ⏳ {}\n", start.name);
            self.write(&text);
        }
    }

    fn handle_content_block_stop(&mut self) {
        if !self.in_reasoning_block {
            return;
        }
        if !self.need_reasoning_indent {
            self.write("\n");
        }
        self.in_reasoning_block = false;
        self.need_reasoning_indent = false;
    }
}

/// The printer's output, and the agent's printer configuration.
#[cfg(test)]
mod tests;
