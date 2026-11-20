//! Input validation for the vended tools.
//!
//! A tool reads each field through an [`InputReader`], which records an issue for a missing or
//! mistyped field and for each failed refinement, then [`finish`](InputReader::finish)es: any
//! issue fails the call with a [`ToolValidationError`] listing them, before the tool does
//! anything.

use crate::error::ToolValidationError;
use crate::tools::ToolError;
use crate::types::{JsonObject, JsonValue};

/// `Number.MAX_SAFE_INTEGER`, the bound of Zod's `.int()`.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// The Zod name of a JSON value's type, as in `expected string, received number`.
pub(crate) fn type_name(value: Option<&JsonValue>) -> &'static str {
    match value {
        None => "undefined",
        Some(JsonValue::Null) => "null",
        Some(JsonValue::Bool(_)) => "boolean",
        Some(JsonValue::Number(_)) => "number",
        Some(JsonValue::String(_)) => "string",
        Some(JsonValue::Array(_)) => "array",
        Some(JsonValue::Object(_)) => "object",
    }
}

/// Reads and validates the fields of a tool input object.
pub(crate) struct InputReader<'a> {
    object: Option<&'a JsonObject>,
    issues: Vec<String>,
}

impl<'a> InputReader<'a> {
    pub(crate) fn new(input: &'a JsonValue) -> Self {
        let mut reader = Self {
            object: input.as_object(),
            issues: Vec::new(),
        };
        if reader.object.is_none() {
            reader.issues.push(format!(
                "- Invalid input: expected object, received {}",
                type_name(Some(input))
            ));
        }
        reader
    }

    /// The raw value of `key`, absent when the input is not an object.
    pub(crate) fn get(&self, key: &str) -> Option<&'a JsonValue> {
        self.object.and_then(|object| object.get(key))
    }

    /// Records a failed check on the whole input.
    pub(crate) fn root_issue(&mut self, message: impl AsRef<str>) {
        self.issues.push(format!("- {}", message.as_ref()));
    }

    /// Records a failed check on `key`.
    pub(crate) fn issue(&mut self, key: &str, message: impl AsRef<str>) {
        self.issues.push(format!("- /{key}: {}", message.as_ref()));
    }

    fn mistyped(&mut self, key: &str, expected: &str, value: Option<&JsonValue>) {
        self.issue(
            key,
            format!("Invalid input: expected {expected}, received {}", type_name(value)),
        );
    }

    /// A required string.
    pub(crate) fn string(&mut self, key: &str) -> Option<&'a str> {
        self.object?;
        let value = self.get(key);
        match value {
            Some(JsonValue::String(text)) => Some(text),
            other => {
                self.mistyped(key, "string", other);
                None
            }
        }
    }

    /// An optional string.
    pub(crate) fn optional_string(&mut self, key: &str) -> Option<&'a str> {
        match self.get(key) {
            None => None,
            Some(_) => self.string(key),
        }
    }

    /// An optional string that may also be `null`, read as absent.
    pub(crate) fn nullable_string(&mut self, key: &str) -> Option<&'a str> {
        match self.get(key) {
            None | Some(JsonValue::Null) => None,
            Some(_) => self.string(key),
        }
    }

    /// A required number.
    pub(crate) fn number(&mut self, key: &str) -> Option<f64> {
        self.object?;
        let value = self.get(key);
        match value.and_then(JsonValue::as_f64) {
            Some(number) => Some(number),
            None => {
                self.mistyped(key, "number", value);
                None
            }
        }
    }

    /// An optional number.
    pub(crate) fn optional_number(&mut self, key: &str) -> Option<f64> {
        match self.get(key) {
            None => None,
            Some(_) => self.number(key),
        }
    }

    /// An optional number that must be positive, with `message` when it is not.
    pub(crate) fn optional_positive(&mut self, key: &str, message: impl FnOnce(f64) -> String) -> Option<f64> {
        let number = self.optional_number(key)?;
        if number > 0.0 {
            return Some(number);
        }
        self.issue(key, message(number));
        None
    }

    /// An optional integer of at least 1, with `message` when it is smaller. As with Zod's
    /// `.int()`, an integer-valued float (`2.0`) is an integer and the value must be a safe
    /// integer.
    pub(crate) fn optional_positive_integer(&mut self, key: &str, message: &str) -> Option<u64> {
        let number = self.optional_number(key)?;
        if number.fract() != 0.0 {
            self.issue(key, "Invalid input: expected int, received number");
            return None;
        }
        if number > MAX_SAFE_INTEGER {
            self.issue(key, "Too big: expected int to be <=9007199254740991");
            return None;
        }
        if number < -MAX_SAFE_INTEGER {
            self.issue(key, "Too small: expected int to be >=-9007199254740991");
        }
        if number < 1.0 {
            self.issue(key, message);
            return None;
        }
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "a safe integer of at least 1"
        )]
        Some(number as u64)
    }

    /// A required string that must be one of `values`.
    pub(crate) fn one_of(&mut self, key: &str, values: &[&str]) -> Option<&'a str> {
        self.object?;
        let value = self.get(key);
        if let Some(text) = value.and_then(JsonValue::as_str)
            && values.contains(&text)
        {
            return value.and_then(JsonValue::as_str);
        }
        let options: Vec<String> = values.iter().map(|value| format!("\"{value}\"")).collect();
        self.issue(key, format!("Invalid option: expected one of {}", options.join("|")));
        None
    }

    /// Fails with every recorded issue.
    pub(crate) fn finish(self) -> Result<(), ToolError> {
        if self.issues.is_empty() {
            return Ok(());
        }
        Err(ToolError::new(ToolValidationError::new(format!(
            "Validation failed:\n{}",
            self.issues.join("\n")
        ))))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn lists_every_issue_with_its_field() {
        let input = json!({"a": 1, "c": "z"});
        let mut reader = InputReader::new(&input);
        assert_eq!(reader.string("a"), None);
        assert_eq!(reader.string("b"), None);
        assert_eq!(reader.one_of("c", &["x", "y"]), None);
        assert_eq!(
            reader.finish().unwrap_err().to_string(),
            "Validation failed:\n- /a: Invalid input: expected string, received number\n- /b: Invalid input: expected string, received undefined\n- /c: Invalid option: expected one of \"x\"|\"y\""
        );
    }

    #[test]
    fn rejects_a_non_object_input() {
        let input = json!([1]);
        let mut reader = InputReader::new(&input);
        assert_eq!(reader.string("a"), None);
        assert_eq!(
            reader.finish().unwrap_err().to_string(),
            "Validation failed:\n- Invalid input: expected object, received array"
        );
    }

    #[test]
    fn reads_optional_and_nullable_fields() {
        let input = json!({"n": null, "p": 2, "i": 3, "f": 1.5});
        let mut reader = InputReader::new(&input);
        assert_eq!(reader.nullable_string("n"), None);
        assert_eq!(reader.optional_string("missing"), None);
        assert_eq!(reader.optional_positive("p", |_| "positive".into()), Some(2.0));
        assert_eq!(reader.optional_positive_integer("i", "at least 1"), Some(3));
        assert_eq!(reader.optional_positive_integer("f", "at least 1"), None);
        assert!(reader.finish().is_err());
    }

    #[test]
    fn reads_an_integer_valued_float_as_an_integer() {
        let input = json!({"two": 2.0, "big": 1e20, "low": -1e20, "zero": 0.0});
        let mut reader = InputReader::new(&input);
        assert_eq!(reader.optional_positive_integer("two", "at least 1"), Some(2));
        assert_eq!(reader.optional_positive_integer("big", "at least 1"), None);
        assert_eq!(reader.optional_positive_integer("low", "at least 1"), None);
        assert_eq!(reader.optional_positive_integer("zero", "at least 1"), None);
        assert_eq!(
            reader.finish().unwrap_err().to_string(),
            "Validation failed:\n- /big: Too big: expected int to be <=9007199254740991\n- /low: Too small: expected int to be >=-9007199254740991\n- /low: at least 1\n- /zero: at least 1"
        );
    }
}
