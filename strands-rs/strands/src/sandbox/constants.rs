//! Validation patterns and shell quoting shared by the sandboxes.

/// The pattern a language or interpreter name must match (`LANGUAGE_PATTERN`): letters, digits,
/// dots, hyphens and underscores. Path separators, spaces and shell metacharacters are rejected.
pub const LANGUAGE_PATTERN: &str = "^[a-zA-Z0-9._-]+$";

/// The pattern an environment variable name must match (`ENV_KEY_PATTERN`): a letter or
/// underscore, then letters, digits or underscores (POSIX names).
pub const ENV_KEY_PATTERN: &str = "^[a-zA-Z_][a-zA-Z0-9_]*$";

/// Whether `language` matches [`LANGUAGE_PATTERN`].
pub(crate) fn is_valid_language(language: &str) -> bool {
    !language.is_empty()
        && language
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// Whether `key` matches [`ENV_KEY_PATTERN`].
pub(crate) fn is_valid_env_key(key: &str) -> bool {
    let mut bytes = key.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == b'_') && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

/// Shell-escapes a value for a POSIX shell command.
///
/// Wraps the value in single quotes and escapes embedded single quotes as `'\''`. Single quotes
/// disable every expansion (variables, backticks, globbing).
///
/// ```
/// use strands::sandbox::shell_quote;
///
/// assert_eq!(shell_quote("it's"), r"'it'\''s'");
/// ```
#[must_use]
pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_pattern_accepts_interpreter_names_only() {
        for valid in ["python3", "node", "fake-lang.99", "py_thon"] {
            assert!(is_valid_language(valid), "{valid}");
        }
        for invalid in ["", "../../bin/sh", "python;rm -rf /", "python -c", "pythön"] {
            assert!(!is_valid_language(invalid), "{invalid}");
        }
    }

    #[test]
    fn env_key_pattern_accepts_posix_names_only() {
        for valid in ["FOO", "_foo", "F00_BAR"] {
            assert!(is_valid_env_key(valid), "{valid}");
        }
        for invalid in ["", "1FOO", "BAD-KEY", "BAD KEY", "FÖO"] {
            assert!(!is_valid_env_key(invalid), "{invalid}");
        }
    }

    #[test]
    fn shell_quote_wraps_in_single_quotes_and_escapes_them() {
        assert_eq!(shell_quote("with spaces"), "'with spaces'");
        assert_eq!(shell_quote("$(whoami)"), "'$(whoami)'");
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
        assert_eq!(shell_quote(""), "''");
    }
}
