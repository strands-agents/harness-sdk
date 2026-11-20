//! The request an invocation belongs to: its limits and usage.

use std::fmt;
use std::sync::{Arc, Mutex, PoisonError};

use crate::error::{Error, Result};
use crate::models::streaming::Usage;
use crate::types::StopReason;

/// Limits for the request a top-level `invoke` or `stream` call starts (`InvokeLimits`).
///
/// Every limit is optional; `None` means no limit on that dimension. Token limits count every
/// model call in the request and are checked before each turn, so the last turn can go over.
/// When several limits are reached at once the stop reason follows the order turns, total tokens,
/// output tokens, structured output attempts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, bon::Builder)]
pub struct InvokeLimits {
    /// Maximum turns (one model call plus the tool calls it requests) across the request.
    pub turns: Option<u64>,
    /// Maximum model-generated tokens across every model call in the request.
    pub output_tokens: Option<u64>,
    /// Maximum input plus output tokens across every model call in the request.
    pub total_tokens: Option<u64>,
    /// Maximum failed structured output attempts across the request.
    pub structured_output_attempts: Option<u64>,
}

/// One of the [`InvokeLimits`] (`keyof InvokeLimits`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum LimitKey {
    /// [`InvokeLimits::turns`].
    Turns,
    /// [`InvokeLimits::output_tokens`].
    OutputTokens,
    /// [`InvokeLimits::total_tokens`].
    TotalTokens,
    /// [`InvokeLimits::structured_output_attempts`].
    StructuredOutputAttempts,
}

impl LimitKey {
    /// The key's name, as used in error messages.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Turns => "turns",
            Self::OutputTokens => "outputTokens",
            Self::TotalTokens => "totalTokens",
            Self::StructuredOutputAttempts => "structuredOutputAttempts",
        }
    }
}

const LIMIT_KEYS: [LimitKey; 4] = [
    LimitKey::Turns,
    LimitKey::OutputTokens,
    LimitKey::TotalTokens,
    LimitKey::StructuredOutputAttempts,
];

impl InvokeLimits {
    /// The value of one limit.
    #[must_use]
    pub fn get(&self, key: LimitKey) -> Option<u64> {
        match key {
            LimitKey::Turns => self.turns,
            LimitKey::OutputTokens => self.output_tokens,
            LimitKey::TotalTokens => self.total_tokens,
            LimitKey::StructuredOutputAttempts => self.structured_output_attempts,
        }
    }

    /// Checks that every set limit is positive, so a zero limit fails fast instead of stopping
    /// the call at once.
    ///
    /// # Errors
    ///
    /// `limits.<key> must be a positive finite number, got 0` for a zero limit.
    pub fn validate(&self) -> Result<()> {
        let zero = LIMIT_KEYS.into_iter().find(|key| self.get(*key) == Some(0));
        match zero {
            Some(key) => Err(Error::other(format!(
                "limits.{} must be a positive finite number, got 0",
                key.as_str()
            ))),
            None => Ok(()),
        }
    }
}

/// What the work in an [`InvocationContext`] has used (`InvocationContextUsage`): its turns and the
/// token usage of every model call, nested and auxiliary calls included.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct InvocationContextUsage {
    /// Turns taken in the context, including its nested calls.
    pub turns_taken: u64,
    /// Token usage of every model call in the context.
    pub usage: Usage,
}

#[derive(Default)]
struct Counters {
    usage: InvocationContextUsage,
    structured_output_failures: u64,
}

struct Inner {
    limits: Option<InvokeLimits>,
    parent: Option<InvocationContext>,
    auxiliary: bool,
    counters: Mutex<Counters>,
}

/// Handle to the request an object belongs to (`InvocationContext`).
///
/// A top-level `invoke` or `stream` call starts a request; the SDK attaches its handle to the
/// events, tool contexts and results it hands out. Pass it to a nested call to run in the same
/// request and share its limits and usage. Only the SDK creates one; its state is read-only.
/// Clones refer to the same request.
#[derive(Clone)]
pub struct InvocationContext {
    inner: Arc<Inner>,
}

#[cfg_attr(not(test), expect(dead_code, reason = "some helpers are used only by tests"))]
impl InvocationContext {
    fn from_parts(limits: Option<InvokeLimits>, parent: Option<Self>, auxiliary: bool) -> Self {
        Self {
            inner: Arc::new(Inner {
                limits,
                parent,
                auxiliary,
                counters: Mutex::default(),
            }),
        }
    }

    /// Starts a request with `limits` (`new InvocationContextImpl(limits)`).
    pub(crate) fn new(limits: Option<InvokeLimits>) -> Self {
        Self::from_parts(limits, None, false)
    }

    /// A nested call with its own limits, bound by the parent's too.
    pub(crate) fn nested(limits: Option<InvokeLimits>, parent: &Self) -> Self {
        Self::from_parts(limits, Some(parent.clone()), false)
    }

    /// Joins `inherited`, or starts a new request with `limits`. A
    /// nested call that sets its own limits gets child state bound by both.
    pub(crate) fn resolve(limits: Option<InvokeLimits>, inherited: Option<&Self>) -> Result<Self> {
        if let Some(limits) = &limits {
            limits.validate()?;
        }
        Ok(match (inherited, limits) {
            (None, limits) => Self::new(limits),
            (Some(inherited), None) => inherited.clone(),
            (Some(inherited), Some(limits)) => Self::nested(Some(limits), inherited),
        })
    }

    /// The context for an auxiliary call made for `parent`:
    /// its tokens add to the request's usage, but no limits apply and its turns do not count.
    pub(crate) fn auxiliary(parent: Option<&Self>) -> Option<Self> {
        parent.map(|parent| Self::from_parts(None, Some(parent.clone()), true))
    }

    fn counters(&self) -> std::sync::MutexGuard<'_, Counters> {
        self.inner.counters.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// What the work in this context has used so far; it keeps growing while that work runs.
    #[must_use]
    pub fn usage(&self) -> InvocationContextUsage {
        self.counters().usage.clone()
    }

    /// The limits checked against this context's usage.
    #[must_use]
    pub fn limits(&self) -> Option<&InvokeLimits> {
        self.inner.limits.as_ref()
    }

    /// Failed structured output attempts counted under this context.
    #[must_use]
    pub(crate) fn structured_output_failures(&self) -> u64 {
        self.counters().structured_output_failures
    }

    /// The parent whose limits also apply to this context.
    fn limiting_parent(&self) -> Option<&Self> {
        if self.inner.auxiliary {
            return None;
        }
        self.inner.parent.as_ref()
    }

    /// Adds one model call's usage here and in every parent.
    pub(crate) fn record_usage(&self, usage: &Usage) {
        self.counters().usage.usage.accumulate(usage);
        if let Some(parent) = &self.inner.parent {
            parent.record_usage(usage);
        }
    }

    /// Counts one turn here and in every parent whose limits apply.
    pub(crate) fn record_turn(&self) {
        let turns = &mut self.counters().usage.turns_taken;
        *turns = turns.saturating_add(1);
        if let Some(parent) = self.limiting_parent() {
            parent.record_turn();
        }
    }

    /// Counts one failed structured output attempt here and in every parent whose limits apply.
    pub(crate) fn record_structured_output_failure(&self) {
        let failures = &mut self.counters().structured_output_failures;
        *failures = failures.saturating_add(1);
        if let Some(parent) = self.limiting_parent() {
            parent.record_structured_output_failure();
        }
    }

    /// Whether this context or a parent whose limits apply sets the limit `key`.
    #[must_use]
    pub(crate) fn has_limit(&self, key: LimitKey) -> bool {
        let own = self.inner.limits.is_some_and(|limits| limits.get(key).is_some());
        own || self.limiting_parent().is_some_and(|parent| parent.has_limit(key))
    }

    /// The stop reason of the first limit reached, own limits first, then each limiting parent's.
    #[must_use]
    pub(crate) fn reached_limit(&self) -> Option<StopReason> {
        self.reached_own_limit()
            .or_else(|| self.limiting_parent().and_then(Self::reached_limit))
    }

    fn reached_own_limit(&self) -> Option<StopReason> {
        let limits = self.inner.limits?;
        let counters = self.counters();
        let usage = &counters.usage;
        let checks = [
            (limits.turns, usage.turns_taken, StopReason::LimitTurns),
            (
                limits.total_tokens,
                usage.usage.total_tokens,
                StopReason::LimitTotalTokens,
            ),
            (
                limits.output_tokens,
                usage.usage.output_tokens,
                StopReason::LimitOutputTokens,
            ),
            (
                limits.structured_output_attempts,
                counters.structured_output_failures,
                StopReason::LimitStructuredOutputAttempts,
            ),
        ];
        checks
            .into_iter()
            .find_map(|(limit, used, reason)| limit.is_some_and(|limit| used >= limit).then_some(reason))
    }

    /// Whether two handles refer to the same context.
    #[must_use]
    pub fn ptr_eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }
}

impl fmt::Debug for InvocationContext {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("InvocationContext")
            .field("limits", &self.inner.limits)
            .field("usage", &self.usage())
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits(turns: Option<u64>, structured_output_attempts: Option<u64>) -> Option<InvokeLimits> {
        Some(InvokeLimits {
            turns,
            structured_output_attempts,
            ..InvokeLimits::default()
        })
    }

    #[test]
    fn counts_toward_limiting_parents_but_not_through_an_auxiliary_call() {
        let request = InvocationContext::new(limits(None, Some(2)));
        let nested = InvocationContext::nested(limits(Some(5), None), &request);
        let auxiliary = InvocationContext::auxiliary(Some(&request)).unwrap();

        nested.record_structured_output_failure();
        auxiliary.record_structured_output_failure();

        assert_eq!(request.structured_output_failures(), 1);
        assert_eq!(nested.reached_limit(), None);
        nested.record_structured_output_failure();
        assert_eq!(nested.reached_limit(), Some(StopReason::LimitStructuredOutputAttempts));
    }

    #[test]
    fn sees_the_limits_of_limiting_parents_only() {
        let request = InvocationContext::new(limits(None, Some(2)));
        let auxiliary = InvocationContext::auxiliary(Some(&request)).unwrap();

        assert_eq!(
            [
                InvocationContext::nested(limits(Some(5), None), &request)
                    .has_limit(LimitKey::StructuredOutputAttempts),
                auxiliary.has_limit(LimitKey::StructuredOutputAttempts),
                InvocationContext::new(limits(Some(5), None)).has_limit(LimitKey::StructuredOutputAttempts),
            ],
            [true, false, false]
        );
    }

    #[test]
    fn usage_adds_to_every_parent_and_turns_skip_auxiliary_parents() {
        let request = InvocationContext::new(None);
        let auxiliary = InvocationContext::auxiliary(Some(&request)).unwrap();
        auxiliary.record_usage(&Usage::new(3, 2, 5));
        auxiliary.record_turn();
        assert_eq!(request.usage().usage, Usage::new(3, 2, 5));
        assert_eq!(request.usage().turns_taken, 0);
        assert_eq!(auxiliary.usage().turns_taken, 1);
    }

    #[test]
    fn reached_limit_checks_turns_before_tokens() {
        let context = InvocationContext::new(Some(InvokeLimits {
            turns: Some(1),
            total_tokens: Some(5),
            ..InvokeLimits::default()
        }));
        context.record_usage(&Usage::new(3, 2, 5));
        assert_eq!(context.reached_limit(), Some(StopReason::LimitTotalTokens));
        context.record_turn();
        assert_eq!(context.reached_limit(), Some(StopReason::LimitTurns));
    }

    #[test]
    fn resolve_joins_or_nests_and_rejects_zero_limits() {
        let request = InvocationContext::resolve(None, None).unwrap();
        assert!(
            InvocationContext::resolve(None, Some(&request))
                .unwrap()
                .ptr_eq(&request)
        );
        let nested = InvocationContext::resolve(limits(Some(2), None), Some(&request)).unwrap();
        assert!(!nested.ptr_eq(&request));
        assert!(nested.has_limit(LimitKey::Turns));
        let error = InvocationContext::resolve(limits(Some(0), None), None).unwrap_err();
        assert_eq!(
            error.to_string(),
            "limits.turns must be a positive finite number, got 0"
        );
    }
}
