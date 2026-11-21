//! Offload conditions: when a strategy fires, how large content must be to act on, and what it
//! protects.

use std::fmt;

use crate::agent::LocalAgent;
use crate::error::{Error, Result};
use crate::experimental::context_manager::types::ContextState;
use crate::models::model_info::default_context_window_limit;

/// One condition value: a whole number, or a `'N%'` share written as a string such as `"70%"`.
///
/// Numbers and strings convert into it, so conditions read as in the docs:
/// `context_utilization: Some("80%".into())`, `block_threshold: Some(1500.into())`.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum ConditionValue {
    /// A number: a count when it is a whole number, rejected otherwise.
    Number(f64),
    /// A string: a share when it reads `N%`, rejected otherwise.
    Text(String),
}

macro_rules! condition_from_number {
    ($($number:ty),*) => {$(
        impl From<$number> for ConditionValue {
            #[allow(clippy::cast_precision_loss, clippy::cast_lossless, reason = "condition values are small")]
            fn from(value: $number) -> Self {
                Self::Number(value as f64)
            }
        }
    )*};
}

condition_from_number!(f64, f32, i32, i64, u32, u64, usize);

impl From<&str> for ConditionValue {
    fn from(value: &str) -> Self {
        Self::Text(value.to_owned())
    }
}

impl From<String> for ConditionValue {
    fn from(value: String) -> Self {
        Self::Text(value)
    }
}

impl fmt::Display for ConditionValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Text(text) => write!(f, "\"{text}\""),
            Self::Number(number) => f.write_str(&js_number(*number)),
        }
    }
}

/// A number as JavaScript prints it, for the values a condition error quotes.
fn js_number(number: f64) -> String {
    if number.is_nan() {
        return "NaN".to_owned();
    }
    if number.is_infinite() {
        return if number > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    number.to_string()
}

/// Conditions that decide when and how an offload strategy fires (`OffloadConditions`).
///
/// - `context_utilization` sets when the strategy fires. `"80%"` fires at 80% of the context
///   window; a whole number of 1,000 or more fires at that many conversation tokens, and is
///   rejected if it exceeds the model's context window.
/// - `block_threshold` sets how large each block, or each message for [`OffloadTarget::All`],
///   must be to act on. A whole number selects content larger than that many tokens; `"5%"`
///   selects content larger than 5% of the context window.
/// - `preserve_recent` sets which matching messages it never touches. A whole number keeps that
///   many of the newest; `"70%"` keeps the newest 70% of them.
///
/// With no `context_utilization`, the strategy runs before every model call, or on each message as
/// it arrives when the target isn't [`OffloadTarget::All`] and `preserve_recent` is unset or 0.
///
/// Target [`OffloadTarget::All`] acts on whole messages: drop removes them, summarize merges each
/// contiguous run, and truncate elides the middle and takes no `block_threshold`. Any other target
/// acts on each block.
///
/// [`OffloadTarget::All`]: super::OffloadTarget::All
#[derive(Debug, Clone, Default, PartialEq, bon::Builder)]
pub struct OffloadConditions {
    /// Context usage at or above which the strategy fires: `"80%"` of the context window, or a
    /// whole number of 1,000 or more for conversation tokens, at most the model's context window.
    #[builder(into)]
    pub context_utilization: Option<ConditionValue>,
    /// Size above which a message (target `All`) or block is offloaded: a whole number of tokens
    /// above 0, or `"5%"` of the context window. Unset, there is no size check. Media the token
    /// count measures as 0, alone or in a tool result, always passes.
    #[builder(into)]
    pub block_threshold: Option<ConditionValue>,
    /// Newest matching messages never touched: a count, or `"70%"` of the matches, rounded up so a
    /// share above 0 keeps at least one.
    #[builder(into)]
    pub preserve_recent: Option<ConditionValue>,
}

/// Which condition a value is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ConditionName {
    ContextUtilization,
    BlockThreshold,
    PreserveRecent,
}

/// Smaller whole numbers are almost always a percent written without "%", like
/// `context_utilization: 80`.
const MIN_UTILIZATION_TOKENS: f64 = 1000.0;

impl ConditionName {
    fn as_str(self) -> &'static str {
        match self {
            Self::ContextUtilization => "contextUtilization",
            Self::BlockThreshold => "blockThreshold",
            Self::PreserveRecent => "preserveRecent",
        }
    }

    fn percent_in_range(self, percent: f64) -> bool {
        match self {
            Self::ContextUtilization => percent > 0.0 && percent <= 100.0,
            Self::BlockThreshold => percent > 0.0 && percent < 100.0,
            Self::PreserveRecent => (0.0..100.0).contains(&percent),
        }
    }

    fn min_count(self) -> f64 {
        match self {
            Self::ContextUtilization => MIN_UTILIZATION_TOKENS,
            Self::BlockThreshold => 1.0,
            Self::PreserveRecent => 0.0,
        }
    }

    fn expected(self) -> &'static str {
        match self {
            Self::ContextUtilization => "a \"N%\" string up to \"100%\" or a whole token count of at least 1000",
            Self::BlockThreshold => "a \"N%\" string below \"100%\" or a whole token count above 0",
            Self::PreserveRecent => "a \"N%\" string below \"100%\" or a whole message count",
        }
    }
}

/// A parsed condition: a count in the condition's unit, or a share of a whole
/// (`ParsedCondition`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct ParsedCondition {
    /// The count, or a share's percent as written.
    pub(crate) value: f64,
    /// Whether `value` is a percent of a whole rather than a count.
    pub(crate) is_share: bool,
}

impl ParsedCondition {
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_precision_loss,
        reason = "counts and wholes are small non-negative numbers"
    )]
    /// The count this condition stands for out of `whole`, rounded up.
    pub(crate) fn of(self, whole: u64) -> u64 {
        if !self.is_share {
            return self.value as u64;
        }
        // Multiplying before dividing keeps "7%" of 100 at 7: `percent / 100` is inexact.
        ((self.value * whole as f64) / 100.0).ceil() as u64
    }

    /// A share's fraction of the whole.
    pub(crate) fn share(self) -> f64 {
        self.value / 100.0
    }
}

/// `N%` or `N.N%`, the percent as a number.
fn parse_percent(text: &str) -> Option<f64> {
    let digits = text.strip_suffix('%')?;
    let (whole, fraction) = digits.split_once('.').unwrap_or((digits, ""));
    let all_digits = |part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
    if !all_digits(whole) || (digits.contains('.') && !all_digits(fraction)) {
        return None;
    }
    digits.parse().ok()
}

/// Parses one condition value: a `'N%'` string is a share, and a whole number is a count
/// (`parseCondition`).
///
/// # Errors
///
/// A value the condition does not accept.
pub(crate) fn parse_condition(name: ConditionName, raw: Option<&ConditionValue>) -> Result<Option<ParsedCondition>> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    match raw {
        ConditionValue::Text(text) => {
            if let Some(percent) = parse_percent(text).filter(|percent| name.percent_in_range(*percent)) {
                return Ok(Some(ParsedCondition {
                    value: percent,
                    is_share: true,
                }));
            }
        }
        ConditionValue::Number(number) => {
            if number.is_finite() && number.fract() == 0.0 && *number >= name.min_count() {
                return Ok(Some(ParsedCondition {
                    value: *number,
                    is_share: false,
                }));
            }
        }
    }
    Err(Error::other(format!(
        "{}={raw} is invalid: expected {}{}",
        name.as_str(),
        name.expected(),
        percent_hint(raw)
    )))
}

/// Suggests the `'N%'` spelling for a rejected number that reads as a share or a percent.
fn percent_hint(raw: &ConditionValue) -> String {
    let ConditionValue::Number(number) = raw else {
        return String::new();
    };
    if !(*number > 0.0 && *number <= 100.0) {
        return String::new();
    }
    let percent = if *number <= 1.0 {
        to_precision_6(number * 100.0)
    } else {
        *number
    };
    let shown = js_number(percent);
    format!("; for {shown}%, write \"{shown}%\"")
}

/// `Number(value.toPrecision(6))`: six significant digits, which drops float noise like
/// `85.00000000000001`.
fn to_precision_6(value: f64) -> f64 {
    format!("{value:.5e}").parse().unwrap_or(value)
}

/// The model's context window, falling back to the default `estimate_utilization` uses.
pub(crate) fn effective_window_limit(agent: &LocalAgent) -> u64 {
    agent
        .model()
        .model_info()
        .limits
        .context_window
        .filter(|limit| *limit > 0)
        .unwrap_or_else(default_context_window_limit)
}

/// A strategy's parsed conditions, and what they resolve to on an agent (`ResolvedConditions`).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(crate) struct ResolvedConditions {
    pub(crate) context_utilization: Option<ParsedCondition>,
    pub(crate) block_threshold: Option<ParsedCondition>,
    pub(crate) preserve_recent: Option<ParsedCondition>,
}

impl ResolvedConditions {
    /// # Errors
    ///
    /// A condition value that is not accepted.
    pub(crate) fn new(conditions: &OffloadConditions) -> Result<Self> {
        let preserve_recent = parse_condition(ConditionName::PreserveRecent, conditions.preserve_recent.as_ref())?;
        Ok(Self {
            context_utilization: parse_condition(
                ConditionName::ContextUtilization,
                conditions.context_utilization.as_ref(),
            )?,
            block_threshold: parse_condition(ConditionName::BlockThreshold, conditions.block_threshold.as_ref())?,
            preserve_recent: preserve_recent.filter(|preserve| preserve.value != 0.0),
        })
    }

    /// Whether no condition narrows when or what the strategy acts on.
    pub(crate) fn is_empty(&self) -> bool {
        self.context_utilization.is_none() && self.block_threshold.is_none() && self.preserve_recent.is_none()
    }

    /// Whether something other than size defers the strategy past a message's arrival.
    pub(crate) fn defers_arrival(&self) -> bool {
        self.context_utilization.is_some() || self.preserve_recent.is_some()
    }

    #[allow(clippy::cast_precision_loss, reason = "token counts are far below 2^52")]
    /// Whether the utilization gate, if any, is open: on overflow, or at or above the configured
    /// share.
    pub(crate) fn reached(&self, context: &ContextState<'_>) -> bool {
        let Some(utilization) = self.context_utilization else {
            return true;
        };
        if context.overflow {
            return true;
        }
        let share = if utilization.is_share {
            utilization.share()
        } else {
            utilization.value / effective_window_limit(context.agent) as f64
        };
        context.utilization >= share
    }

    /// Tokens above which content is offloaded, or `None` when `block_threshold` is unset so no
    /// size check applies.
    pub(crate) fn threshold_tokens(&self, agent: &LocalAgent) -> Option<u64> {
        let threshold = self.block_threshold?;
        if threshold.is_share {
            return Some(threshold.of(effective_window_limit(agent)));
        }
        Some(threshold.of(0))
    }

    /// `matching` without the newest ones `preserve_recent` protects.
    pub(crate) fn without_preserved<T: Clone>(&self, matching: &[T]) -> Vec<T> {
        let keep = self.preserve_recent.map_or(0, |preserve| {
            usize::try_from(preserve.of(matching.len() as u64)).unwrap_or(usize::MAX)
        });
        if keep >= matching.len() {
            return Vec::new();
        }
        matching[..matching.len() - keep].to_vec()
    }

    /// Checks a token-count `context_utilization` fits the model's context window.
    ///
    /// # Errors
    ///
    /// A token count larger than the model's context window.
    pub(crate) fn check_fits(&self, agent: &LocalAgent) -> Result<()> {
        let Some(utilization) = self.context_utilization.filter(|utilization| !utilization.is_share) else {
            return Ok(());
        };
        let tokens = js_number(utilization.value);
        let Some(limit) = agent
            .model()
            .model_info()
            .limits
            .context_window
            .filter(|limit| *limit > 0)
        else {
            tracing::warn!(
                "contextUtilization=<{tokens}> | contextWindowLimit is not set on the model, skipping the context window check | set contextWindowLimit in your model config"
            );
            return Ok(());
        };
        #[allow(clippy::cast_precision_loss, reason = "context windows are far below 2^52")]
        if utilization.value <= limit as f64 {
            return Ok(());
        }
        Err(Error::other(format!(
            "contextUtilization ({tokens}) is larger than the model's context window ({limit} tokens); use a smaller token count or a \"N%\" share"
        )))
    }
}

#[cfg(test)]
#[path = "conditions_tests.rs"]
mod tests;
