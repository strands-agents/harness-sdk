//! Stop reasons.

use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Why the model or the agent loop stopped (`StopReason`).
///
/// The set is open: a value this version does not know round-trips through [`StopReason::Other`].
/// Build values from strings with `StopReason::from`, so a known string such as `"endTurn"` always
/// becomes its named variant and compares equal to it.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum StopReason {
    /// The invocation was cancelled.
    Cancelled,
    /// The agent paused at a cycle boundary for durable execution.
    Checkpoint,
    /// Content was filtered by safety mechanisms.
    ContentFiltered,
    /// Natural end of the model's turn.
    EndTurn,
    /// A guardrail policy stopped generation.
    GuardrailIntervened,
    /// Execution was interrupted for human input.
    Interrupt,
    /// The provider's per-call token cap was reached.
    MaxTokens,
    /// The invocation's `outputTokens` limit was reached.
    LimitOutputTokens,
    /// The invocation's `structuredOutputAttempts` limit was reached.
    LimitStructuredOutputAttempts,
    /// The invocation's `totalTokens` limit was reached.
    LimitTotalTokens,
    /// The invocation's `turns` limit was reached.
    LimitTurns,
    /// The model paused a long-running turn; send the response back to continue.
    PauseTurn,
    /// A streaming classifier intervened on a potential policy violation.
    Refusal,
    /// A stop sequence was encountered.
    StopSequence,
    /// The model wants to use a tool.
    ToolUse,
    /// The input exceeded the model's context window.
    ModelContextWindowExceeded,
    /// Any other value, kept verbatim.
    Other(UnknownStopReason),
}

/// A stop reason string this version does not recognize.
///
/// Only `StopReason::from` creates one, so it never holds a known value.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct UnknownStopReason(String);

impl UnknownStopReason {
    /// The value as received.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for UnknownStopReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Stop reasons for a call that stopped because an invocation limit was reached
/// (`LIMIT_STOP_REASONS`).
pub(crate) const LIMIT_STOP_REASONS: [StopReason; 4] = [
    StopReason::LimitTurns,
    StopReason::LimitTotalTokens,
    StopReason::LimitOutputTokens,
    StopReason::LimitStructuredOutputAttempts,
];

const KNOWN: [(StopReason, &str); 16] = [
    (StopReason::Cancelled, "cancelled"),
    (StopReason::Checkpoint, "checkpoint"),
    (StopReason::ContentFiltered, "contentFiltered"),
    (StopReason::EndTurn, "endTurn"),
    (StopReason::GuardrailIntervened, "guardrailIntervened"),
    (StopReason::Interrupt, "interrupt"),
    (StopReason::MaxTokens, "maxTokens"),
    (StopReason::LimitOutputTokens, "limitOutputTokens"),
    (
        StopReason::LimitStructuredOutputAttempts,
        "limitStructuredOutputAttempts",
    ),
    (StopReason::LimitTotalTokens, "limitTotalTokens"),
    (StopReason::LimitTurns, "limitTurns"),
    (StopReason::PauseTurn, "pauseTurn"),
    (StopReason::Refusal, "refusal"),
    (StopReason::StopSequence, "stopSequence"),
    (StopReason::ToolUse, "toolUse"),
    (StopReason::ModelContextWindowExceeded, "modelContextWindowExceeded"),
];

impl StopReason {
    /// The wire string, for example `"endTurn"`.
    #[must_use]
    pub fn as_str(&self) -> &str {
        if let Self::Other(value) = self {
            return value.as_str();
        }
        KNOWN
            .iter()
            .find_map(|(reason, name)| (reason == self).then_some(*name))
            .unwrap_or_default()
    }

    /// Whether the call stopped because an invocation limit was reached.
    #[must_use]
    pub fn is_limit(&self) -> bool {
        LIMIT_STOP_REASONS.contains(self)
    }
}

impl From<&str> for StopReason {
    fn from(value: &str) -> Self {
        KNOWN
            .iter()
            .find_map(|(reason, name)| (*name == value).then(|| reason.clone()))
            .unwrap_or_else(|| Self::Other(UnknownStopReason(value.to_owned())))
    }
}

impl From<String> for StopReason {
    fn from(value: String) -> Self {
        match KNOWN.iter().find(|(_, name)| *name == value) {
            Some((reason, _)) => reason.clone(),
            None => Self::Other(UnknownStopReason(value)),
        }
    }
}

impl fmt::Display for StopReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl Serialize for StopReason {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for StopReason {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(Self::from(String::deserialize(deserializer)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_known_value_round_trips_through_its_wire_string() {
        for (reason, name) in KNOWN {
            assert_eq!(reason.as_str(), name);
            assert_eq!(StopReason::from(name), reason);
            assert_eq!(serde_json::to_string(&reason).unwrap(), format!("\"{name}\""));
        }
    }

    #[test]
    fn unknown_values_are_preserved() {
        let reason: StopReason = serde_json::from_str("\"provider_special\"").unwrap();
        assert_eq!(reason, StopReason::from("provider_special"));
        assert!(matches!(&reason, StopReason::Other(other) if other.as_str() == "provider_special"));
        assert_eq!(serde_json::to_string(&reason).unwrap(), "\"provider_special\"");
        assert!(!reason.is_limit());
    }

    #[test]
    fn known_strings_never_become_other() {
        assert_eq!(StopReason::from(String::from("endTurn")), StopReason::EndTurn);
        assert!(!matches!(StopReason::from("toolUse"), StopReason::Other(_)));
    }

    #[test]
    fn limit_stop_reasons_are_the_four_limit_values() {
        assert!(StopReason::LimitTurns.is_limit());
        assert!(StopReason::LimitTotalTokens.is_limit());
        assert!(StopReason::LimitOutputTokens.is_limit());
        assert!(StopReason::LimitStructuredOutputAttempts.is_limit());
        assert!(!StopReason::MaxTokens.is_limit());
        assert!(!StopReason::EndTurn.is_limit());
    }
}
