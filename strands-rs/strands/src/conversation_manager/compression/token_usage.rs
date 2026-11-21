//! The token-usage middleware of the agentic context manager: appends the projected
//! context-window usage to the last message the model sees.

use crate::middleware::{InvokeModelContext, InvokeModelStage, Middleware, StageResult};
use crate::models::model_info::default_context_window_limit;
use crate::types::{ContentBlock, Message, Role};

/// Formats an integer with `,` thousands separators (`toLocaleString('en-US')`).
fn with_separators(value: u64) -> String {
    let digits = value.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// The `<context-status>` block for `projected` of `limit` tokens.
fn status_text(projected: u64, limit: u64) -> String {
    let remaining = limit.saturating_sub(projected);
    #[allow(clippy::cast_precision_loss, reason = "a display percentage")]
    let percent = projected as f64 / limit as f64 * 100.0;
    format!(
        "\n\n<context-status>\n<used>{} / {} tokens ({percent:.1}%)</used>\n<remaining>~{} tokens</remaining>\n</context-status>",
        with_separators(projected),
        with_separators(limit),
        with_separators(remaining)
    )
}

/// Appends the status block to the context's last message.
pub(crate) fn add_token_usage(mut context: InvokeModelContext) -> InvokeModelContext {
    let Some(projected) = context.projected_input_tokens else {
        return context;
    };
    let limit = context
        .model
        .model_info()
        .limits
        .context_window
        .filter(|limit| *limit > 0)
        .unwrap_or_else(default_context_window_limit);
    let Some(last) = context.messages.last_mut() else {
        return context;
    };
    let mut content = last.content.clone();
    content.push(ContentBlock::text(status_text(projected, limit)));
    let mut replaced = Message::new(last.role, content);
    replaced.metadata.clone_from(&last.metadata);
    let appended = usize::from(last.role == Role::User);
    *last = replaced;
    if appended > 0 {
        context.dynamic_trailing_blocks = Some(context.dynamic_trailing_blocks.unwrap_or(0) + appended);
    }
    context
}

/// The middleware form, registered by the agentic context manager.
pub(crate) fn token_usage_middleware() -> Middleware<InvokeModelStage> {
    InvokeModelStage::input(|context| async move { StageResult::Ok(add_token_usage(context)) })
}
