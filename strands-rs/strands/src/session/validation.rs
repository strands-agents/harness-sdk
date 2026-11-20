//! Identifier checks for session storage paths.
//!
//! The errors are plain [`Error::Other`] values.

use crate::error::{Error, Result};
use crate::types::Scope;

/// Checks that `id` is non-empty and only has lowercase letters, digits, `-` and `_`
/// (`^[a-z0-9_-]+$`).
pub(crate) fn validate_identifier(id: &str) -> Result<&str> {
    let valid = !id.is_empty()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-' || byte == b'_');
    if !valid {
        return Err(Error::other(format!(
            "Identifier '{id}' can only contain lowercase letters, numbers, hyphens, and underscores"
        )));
    }
    Ok(id)
}

/// Parses a scope name, `agent` or `multiAgent`.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "scopes come from typed locations; only the tests parse scope strings"
    )
)]
pub(crate) fn validate_scope(scope: &str) -> Result<Scope> {
    match scope {
        "agent" => Ok(Scope::Agent),
        "multiAgent" => Ok(Scope::MultiAgent),
        other => Err(Error::other(format!(
            "Invalid scope '{other}': must be 'agent' or 'multiAgent'"
        ))),
    }
}

/// The scope's name in storage keys, as it serializes.
pub(crate) fn scope_name(scope: Scope) -> &'static str {
    match scope {
        Scope::Agent => "agent",
        Scope::MultiAgent => "multiAgent",
    }
}

/// Checks that `id` is a UUID v7, any letter case (`validateUuidV7`).
pub(crate) fn validate_uuid_v7(id: &str) -> Result<()> {
    if !is_uuid_v7(id) {
        return Err(Error::other(format!("'{id}' is not a valid UUID v7 snapshot ID")));
    }
    Ok(())
}

/// `^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`, case-insensitive.
fn is_uuid_v7(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            14 => byte == b'7',
            19 => matches!(byte.to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b'),
            _ => byte.is_ascii_hexdigit(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_the_identifier() {
        assert_eq!(validate_identifier("valid-id").unwrap(), "valid-id");
    }

    #[test]
    fn identifier_with_forward_slash_throws_error() {
        assert_eq!(
            validate_identifier("invalid/id").unwrap_err().to_string(),
            "Identifier 'invalid/id' can only contain lowercase letters, numbers, hyphens, and underscores"
        );
    }

    #[test]
    fn identifier_with_backslash_throws_error() {
        assert_eq!(
            validate_identifier("invalid\\id").unwrap_err().to_string(),
            "Identifier 'invalid\\id' can only contain lowercase letters, numbers, hyphens, and underscores"
        );
    }

    #[test]
    fn rejects_uppercase_empty_and_trailing_newline_identifiers() {
        for id in ["Invalid", "", "abc\n", "a.b"] {
            assert_eq!(validate_identifier(id).unwrap_err().name(), "Error", "{id:?}");
        }
        assert_eq!(validate_identifier("a_b-9").unwrap(), "a_b-9");
    }

    #[test]
    fn returns_the_scope() {
        assert_eq!(
            [validate_scope("agent").unwrap(), validate_scope("multiAgent").unwrap()],
            [Scope::Agent, Scope::MultiAgent]
        );
        assert_eq!(
            [scope_name(Scope::Agent), scope_name(Scope::MultiAgent)],
            ["agent", "multiAgent"]
        );
    }

    #[test]
    fn scope_with_path_traversal_throws_error() {
        assert_eq!(
            validate_scope("../../outside").unwrap_err().to_string(),
            "Invalid scope '../../outside': must be 'agent' or 'multiAgent'"
        );
    }

    #[test]
    fn valid_uuid_v7_does_not_throw() {
        validate_uuid_v7("01956891-2b4c-7000-8abc-123456789abc").unwrap();
        validate_uuid_v7("01956891-2B4C-7000-ABCD-123456789ABC").unwrap();
    }

    #[test]
    fn uuid_v4_wrong_version_throws_error() {
        assert_eq!(
            validate_uuid_v7("550e8400-e29b-41d4-a716-446655440000")
                .unwrap_err()
                .to_string(),
            "'550e8400-e29b-41d4-a716-446655440000' is not a valid UUID v7 snapshot ID"
        );
    }

    #[test]
    fn timestamp_string_throws_error() {
        assert_eq!(
            validate_uuid_v7("2025-01-15T10:30:00Z").unwrap_err().to_string(),
            "'2025-01-15T10:30:00Z' is not a valid UUID v7 snapshot ID"
        );
    }

    #[test]
    fn uuid_with_path_traversal_throws_error() {
        assert_eq!(
            validate_uuid_v7("../evil").unwrap_err().to_string(),
            "'../evil' is not a valid UUID v7 snapshot ID"
        );
    }

    #[test]
    fn empty_uuid_throws_error() {
        assert_eq!(
            validate_uuid_v7("").unwrap_err().to_string(),
            "'' is not a valid UUID v7 snapshot ID"
        );
    }

    #[test]
    fn rejects_a_wrong_variant_nibble() {
        assert!(validate_uuid_v7("01956891-2b4c-7000-cabc-123456789abc").is_err());
    }
}
