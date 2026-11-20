//! Interrupt request and response types.

use serde::{Deserialize, Serialize};

use super::json::JsonValue;

/// Parameters for raising an interrupt (`InterruptParams`).
///
/// Build with [`InterruptParams::new`] (or `"name".into()`) and the `with_*` setters.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct InterruptParams {
    /// Name of the interrupt, unique within one hook callback or tool execution.
    pub name: String,
    /// Why the interrupt was raised.
    pub reason: Option<JsonValue>,
    /// A preemptive response. When set, the interrupt returns it at once instead of halting, for
    /// example to reuse an approval saved in an earlier session.
    pub response: Option<JsonValue>,
}

impl InterruptParams {
    /// Creates parameters with a name.
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            reason: None,
            response: None,
        }
    }

    /// Sets the reason.
    #[must_use]
    pub fn with_reason(mut self, reason: impl Into<JsonValue>) -> Self {
        self.reason = Some(reason.into());
        self
    }

    /// Sets a preemptive response.
    #[must_use]
    pub fn with_response(mut self, response: impl Into<JsonValue>) -> Self {
        self.response = Some(response.into());
        self
    }
}

impl From<&str> for InterruptParams {
    fn from(name: &str) -> Self {
        Self::new(name)
    }
}

impl From<String> for InterruptParams {
    fn from(name: String) -> Self {
        Self::new(name)
    }
}

/// A user's response to an interrupt (`InterruptResponse`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct InterruptResponse {
    /// The id of the interrupt being answered.
    pub interrupt_id: String,
    /// The user's response.
    pub response: JsonValue,
}

impl InterruptResponse {
    /// Creates a response to an interrupt.
    pub fn new(interrupt_id: impl Into<String>, response: impl Into<JsonValue>) -> Self {
        Self {
            interrupt_id: interrupt_id.into(),
            response: response.into(),
        }
    }
}

/// Content that resumes an interrupted agent with a response (`InterruptResponseContent`).
///
/// Wire shape: `{"interruptResponse": {"interruptId": "...", "response": ...}}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct InterruptResponseContent {
    /// The interrupt response.
    pub interrupt_response: InterruptResponse,
}

impl InterruptResponseContent {
    /// Wraps an interrupt response.
    pub fn new(interrupt_response: InterruptResponse) -> Self {
        Self { interrupt_response }
    }
}

impl From<InterruptResponse> for InterruptResponseContent {
    fn from(interrupt_response: InterruptResponse) -> Self {
        Self::new(interrupt_response)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn interrupt_response_content_uses_the_wrapped_wire_shape() {
        let content = InterruptResponseContent::new(InterruptResponse::new("int-1", "approved"));
        assert_eq!(
            serde_json::to_value(&content).unwrap(),
            json!({"interruptResponse": {"interruptId": "int-1", "response": "approved"}})
        );
    }

    #[test]
    fn interrupt_params_convert_from_a_name() {
        let params = InterruptParams::from("confirm").with_reason(json!("Please confirm"));
        assert_eq!(params.name, "confirm");
        assert_eq!(params.reason, Some(json!("Please confirm")));
        assert_eq!(
            InterruptParams::from(String::from("confirm")),
            InterruptParams::new("confirm")
        );
    }
}
