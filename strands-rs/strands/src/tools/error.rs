//! [`ToolError`], the error type of tool bodies.

use std::error::Error as StdError;
use std::fmt;
use std::sync::Arc;

use super::tool::ToolOutcome;
use crate::error::BoxError;
use crate::interrupt::InterruptError;
use crate::types::{ToolResultBlock, ToolResultContent, ToolResultError};

/// The error a tool body returns, much like `anyhow::Error`.
///
/// Any [`std::error::Error`] converts into it with `?`, and so does the [`InterruptError`] that
/// [`ToolContext::interrupt`](crate::tools::ToolContext::interrupt) returns, also after it passed
/// through a [`BoxError`]. The model sees a failure as an error result with the text
/// `Error: <message>`; an interrupt ends the tool as [`ToolOutcome::Interrupt`] instead, so a tool
/// cannot turn an interrupt into a failure by accident.
///
/// `ToolError` does not implement [`std::error::Error`] itself, which is what lets every error
/// type convert into it.
///
/// ```
/// use strands::ToolError;
///
/// fn parse(input: &str) -> Result<u32, ToolError> {
///     Ok(input.parse::<u32>()?)
/// }
///
/// assert_eq!(parse("x").unwrap_err().to_string(), "invalid digit found in string");
/// assert_eq!(ToolError::msg("city not found").to_string(), "city not found");
/// ```
pub struct ToolError {
    repr: Box<Repr>,
}

enum Repr {
    Error(ToolResultError),
    Interrupt(InterruptError),
}

#[derive(Debug)]
struct MessageError(String);

impl fmt::Display for MessageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl StdError for MessageError {}

impl ToolError {
    /// Creates an error from a message.
    pub fn msg(message: impl fmt::Display) -> Self {
        Self::new(MessageError(message.to_string()))
    }

    /// Wraps an error; an [`InterruptError`] stays an interrupt.
    pub fn new(error: impl StdError + Send + Sync + 'static) -> Self {
        Self::from_boxed(Box::new(error))
    }

    /// Wraps a boxed error: a [`BoxError`], or what an error type without a
    /// [`std::error::Error`] impl (such as `anyhow::Error`) converts into. `BoxError` cannot
    /// convert with `?` itself, because it does not implement `std::error::Error`.
    ///
    /// ```
    /// use strands::{BoxError, ToolError};
    ///
    /// fn lookup() -> Result<u32, BoxError> {
    ///     Err("not found".into())
    /// }
    ///
    /// fn tool_body() -> Result<u32, ToolError> {
    ///     lookup().map_err(ToolError::from_boxed)
    /// }
    ///
    /// assert_eq!(tool_body().unwrap_err().to_string(), "not found");
    /// ```
    ///
    /// An [`InterruptError`] inside stays an interrupt.
    #[must_use]
    pub fn from_boxed(error: BoxError) -> Self {
        let repr = match error.downcast::<InterruptError>() {
            Ok(interrupt) => Repr::Interrupt(*interrupt),
            Err(error) => Repr::Error(Arc::from(error)),
        };
        Self { repr: Box::new(repr) }
    }

    /// Whether this is an interrupt rather than a failure.
    #[must_use]
    pub fn is_interrupt(&self) -> bool {
        matches!(*self.repr, Repr::Interrupt(_))
    }

    /// The interrupts, when this is one.
    #[must_use]
    pub fn as_interrupt(&self) -> Option<&InterruptError> {
        match &*self.repr {
            Repr::Interrupt(interrupt) => Some(interrupt),
            Repr::Error(_) => None,
        }
    }

    /// The underlying error, unless this is an interrupt.
    #[must_use]
    pub fn as_error(&self) -> Option<&(dyn StdError + Send + Sync + 'static)> {
        match &*self.repr {
            Repr::Error(error) => Some(error.as_ref()),
            Repr::Interrupt(_) => None,
        }
    }

    /// The outcome of a tool that failed with this error: an error result with the text
    /// `Error: <message>` that keeps the error, or the interrupt.
    #[must_use]
    pub fn into_outcome(self, tool_use_id: impl Into<String>) -> ToolOutcome {
        match *self.repr {
            Repr::Interrupt(interrupt) => ToolOutcome::Interrupt(interrupt),
            Repr::Error(error) => {
                let text = format!("Error: {error}");
                let mut result = ToolResultBlock::error(tool_use_id, vec![ToolResultContent::text(text)]);
                result.error = Some(error);
                ToolOutcome::Result(result)
            }
        }
    }
}

impl<E: StdError + Send + Sync + 'static> From<E> for ToolError {
    fn from(error: E) -> Self {
        Self::new(error)
    }
}

impl fmt::Display for ToolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &*self.repr {
            Repr::Error(error) => fmt::Display::fmt(error, f),
            Repr::Interrupt(interrupt) => fmt::Display::fmt(interrupt, f),
        }
    }
}

impl fmt::Debug for ToolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &*self.repr {
            Repr::Error(error) => fmt::Debug::fmt(error, f),
            Repr::Interrupt(interrupt) => f.debug_tuple("Interrupt").field(interrupt).finish(),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::Error;
    use crate::interrupt::Interrupt;

    #[test]
    fn failures_become_error_results_with_the_error_kept() {
        let error: ToolError = Error::other("city not found").into();
        assert!(!error.is_interrupt());
        let ToolOutcome::Result(result) = error.into_outcome("t-1") else {
            panic!("expected a result");
        };
        assert_eq!(
            serde_json::to_value(&result).unwrap(),
            json!({"toolUseId": "t-1", "status": "error", "content": [{"text": "Error: city not found"}]})
        );
        assert_eq!(result.error.unwrap().to_string(), "city not found");
    }

    #[test]
    fn interrupts_stay_interrupts() {
        let interrupt = InterruptError::from(Interrupt::new("tool:t-1:confirm", "confirm"));
        let error = ToolError::from(interrupt.clone());
        assert_eq!(error.to_string(), "Interrupt raised: confirm");
        assert_eq!(error.as_interrupt(), Some(&interrupt));
        assert!(error.as_error().is_none());
        assert_eq!(error.into_outcome("t-1"), ToolOutcome::Interrupt(interrupt));
    }

    #[test]
    fn interrupts_survive_a_box_error() {
        let interrupts = InterruptError::new([Interrupt::new("a", "a"), Interrupt::new("b", "b")]);
        let boxed: BoxError = Box::new(interrupts.clone());
        let error = ToolError::from_boxed(boxed);
        assert_eq!(error.to_string(), "2 interrupts raised: a, b");
        assert_eq!(error.into_outcome("t-1"), ToolOutcome::Interrupt(interrupts));
        let failure = ToolError::from_boxed("plain".into());
        assert!(!failure.is_interrupt());
        assert_eq!(failure.to_string(), "plain");
    }

    #[test]
    fn tool_error_is_one_pointer() {
        assert_eq!(std::mem::size_of::<ToolError>(), std::mem::size_of::<usize>());
    }
}
