//! Tools: the [`Tool`] trait and its stream, [`ToolContext`], [`ToolError`], [`FunctionTool`], the
//! [`ToolRegistry`], structured output, input schemas and the [`executors`].
//!
//! # Converting errors
//!
//! A tool body fails with a [`ToolError`]. `?` converts any [`std::error::Error`] into one, and
//! the interrupt [`ToolContext::interrupt`] returns as well. A [`BoxError`](crate::BoxError), and
//! error types without a `std::error::Error` impl such as `anyhow::Error`, do not convert with
//! `?`; wrap them with [`ToolError::from_boxed`] (or [`ToolError::msg`] for any `Display`). A
//! `#[tool]` function may instead return `Result<T, E>` for any `E: Into<BoxError>`, and the macro
//! converts the error.
//!
//! ```
//! use strands::{BoxError, Tool, ToolError, tool};
//!
//! fn lookup(sku: &str) -> Result<u32, BoxError> {
//!     if sku == "sku-1" { Ok(3) } else { Err(format!("unknown sku {sku}").into()) }
//! }
//!
//! /// Look up stock for a product, plus a reserve.
//! #[tool]
//! async fn check_stock(sku: String, reserve: String) -> Result<u32, ToolError> {
//!     let reserve: u32 = reserve.parse()?;
//!     let stock = lookup(&sku).map_err(ToolError::from_boxed)?;
//!     Ok(stock + reserve)
//! }
//!
//! /// Look up stock for a product.
//! #[tool]
//! async fn check_stock_boxed(sku: String) -> Result<u32, BoxError> {
//!     lookup(&sku)
//! }
//!
//! assert_eq!(CheckStock.name(), "check_stock");
//! assert_eq!(CheckStockBoxed.name(), "check_stock_boxed");
//! ```

mod error;
pub mod executors;
mod function_tool;
mod load_tools;
mod noop_tool;
mod registry;
mod schema;
mod source;
mod structured_output_tool;
mod tool;

pub use error::ToolError;
pub use executors::{ConcurrentToolExecutor, SequentialToolExecutor, ToolExecutorStrategy};
pub(crate) use function_tool::wrap_in_tool_result;
pub use function_tool::{FunctionTool, FunctionToolBuilder, FunctionToolItem};
pub use load_tools::LOAD_TOOLS_TOOL_NAME;
pub(crate) use load_tools::{DeferredToolsFn, create_load_tools};
#[cfg(feature = "bedrock")]
pub(crate) use noop_tool::NOOP_TOOL_SPEC;
pub use registry::ToolRegistry;
pub use schema::{SchemaValidator, normalize_schema, schema_for};
pub(crate) use source::SourceParts;
pub use source::ToolSource;
pub use structured_output_tool::{STRUCTURED_OUTPUT_TOOL_NAME, StructuredOutputTool};
#[doc(hidden)]
pub use tool::SdkToolRole;
pub(crate) use tool::{DelegationToken, InterruptFn, has_sdk_tool_role};
pub use tool::{
    Tool, ToolContext, ToolOutcome, ToolStream, ToolStreamEvent, ToolStreamItem, create_error_result,
    is_valid_tool_name,
};
