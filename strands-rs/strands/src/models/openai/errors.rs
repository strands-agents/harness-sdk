//! Error classification for the OpenAI provider.

use crate::types::JsonValue;

/// Phrases of context window overflow errors observed across OpenAI responses, matched
/// case-insensitively.
const CONTEXT_WINDOW_OVERFLOW_PATTERNS: [&str; 8] = [
    "maximum context length",
    "context_length_exceeded",
    "too many tokens",
    "context length",
    "input is too long for requested model",
    "input length and `max_tokens` exceed context limit",
    "too many total text bytes",
    "exceed customer model maximum",
];

/// Phrases of rate limit errors, matched case-insensitively.
const RATE_LIMIT_PATTERNS: [&str; 3] = ["rate_limit_exceeded", "rate limit", "too many requests"];

/// What an OpenAI error means to the SDK (`OpenAIErrorKind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum OpenAIErrorKind {
    ContextOverflow,
    Throttling,
}

/// Classifies an error by its message, HTTP status and `code`.
///
/// OpenAI-compatible providers can send a number or `null` as the code; only a string code is
/// compared.
pub(super) fn classify_openai_error(
    message: &str,
    status: Option<u16>,
    code: Option<&JsonValue>,
) -> Option<OpenAIErrorKind> {
    let message = message.to_lowercase();
    let code = code
        .and_then(JsonValue::as_str)
        .map(str::to_lowercase)
        .unwrap_or_default();
    let throttled = status == Some(429)
        || code == "rate_limit_exceeded"
        || RATE_LIMIT_PATTERNS.iter().any(|pattern| message.contains(pattern));
    if throttled {
        return Some(OpenAIErrorKind::Throttling);
    }
    let overflow = code == "context_length_exceeded"
        || CONTEXT_WINDOW_OVERFLOW_PATTERNS
            .iter()
            .any(|pattern| message.contains(pattern));
    overflow.then_some(OpenAIErrorKind::ContextOverflow)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn classify(message: &str) -> Option<OpenAIErrorKind> {
        classify_openai_error(message, None, None)
    }

    #[test]
    fn classifies_overflow_phrase_as_context_overflow() {
        for phrase in [
            "maximum context length exceeded",
            "context_length_exceeded",
            "too many tokens",
            "context length",
            "Input is too long for requested model",
            "input length and `max_tokens` exceed context limit",
            "too many total text bytes",
            "prompt tokens (320666) exceed customer model maximum (278528) for model-id",
        ] {
            assert_eq!(classify(phrase), Some(OpenAIErrorKind::ContextOverflow), "{phrase}");
        }
    }

    #[test]
    fn matches_overflow_phrases_case_insensitively() {
        assert_eq!(
            classify("MAXIMUM CONTEXT LENGTH EXCEEDED"),
            Some(OpenAIErrorKind::ContextOverflow)
        );
    }

    #[test]
    fn classifies_a_structured_context_length_exceeded_code_as_context_overflow() {
        let code = json!("context_length_exceeded");
        assert_eq!(
            classify_openai_error("something opaque", None, Some(&code)),
            Some(OpenAIErrorKind::ContextOverflow)
        );
    }

    #[test]
    fn matches_structured_codes_case_insensitively() {
        let code = json!("Context_Length_Exceeded");
        assert_eq!(
            classify_openai_error("something opaque", None, Some(&code)),
            Some(OpenAIErrorKind::ContextOverflow)
        );
    }

    #[test]
    fn returns_undefined_for_unrelated_errors() {
        assert_eq!(classify("a totally unrelated failure"), None);
    }

    #[test]
    fn handles_numeric_error_codes_without_throwing() {
        let code = json!(400);
        assert_eq!(classify_openai_error("some error", None, Some(&code)), None);
    }

    #[test]
    fn handles_null_error_code_without_throwing() {
        let code = JsonValue::Null;
        assert_eq!(classify_openai_error("some error", None, Some(&code)), None);
    }

    #[test]
    fn classifies_a_429_status_and_rate_limit_codes_as_throttling() {
        let code = json!("rate_limit_exceeded");
        assert_eq!(
            classify_openai_error("opaque", Some(429), None),
            Some(OpenAIErrorKind::Throttling)
        );
        assert_eq!(
            classify_openai_error("opaque", None, Some(&code)),
            Some(OpenAIErrorKind::Throttling)
        );
        assert_eq!(classify("Too many requests"), Some(OpenAIErrorKind::Throttling));
    }
}
