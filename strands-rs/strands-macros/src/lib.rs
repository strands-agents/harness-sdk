//! Procedural macros for the Strands Agents Rust SDK: [`macro@tool`] and [`macro@tools`].
//!
//! Use them through the `strands` crate (`strands::tool`, `strands::tools`); the generated code
//! names only `strands` paths, so a crate needs no `serde` or `schemars` dependency of its own.

mod attrs;
mod docs;
mod expand;
mod signature;
mod tool_fn;
mod tools_impl;

use proc_macro::TokenStream;

/// Turns an `async fn` into a Strands tool.
///
/// The function stays callable as written. Next to it the macro generates a unit struct named
/// after the function in PascalCase (`get_weather` becomes `GetWeather`) that implements
/// `strands::Tool` and is `Clone`, `Copy`, `Default` and `Debug`.
///
/// - **Name.** The model-facing name is the function name; `#[tool(name = "..")]` overrides it.
///   Names are 1 to 64 ASCII letters, digits, `_` or `-`.
/// - **Description.** The function's doc comment up to its first section heading (`# Errors`,
///   `# Examples`, ...), trimmed, with paragraphs kept; `#[tool(description = "..")]` overrides it.
///   A tool without either does not compile, since models need the description to pick tools.
/// - **Input.** The parameters form the input schema, in order: each parameter's doc comment is
///   its `description`, `Option<T>` parameters are optional, and `#[serde(..)]` and
///   `#[schemars(..)]` attributes on a parameter apply to its property. Parameter types implement
///   `serde::Deserialize` and `schemars::JsonSchema`. The schema is normalized as
///   `strands::tools::schema_for` does, computed once, and declares `additionalProperties: false`.
///   The input is validated against it before the call; invalid input becomes an error result
///   listing the violations, and unknown keys are ignored. A tool without parameters has the
///   empty object schema and takes its input as given.
/// - **Context.** One parameter of type `&ToolContext` marked `#[tool(context)]` receives the
///   call's context; it is not part of the schema.
/// - **Return value.** `Result<T, E>` with `E: Into<ToolError>` (any `std::error::Error`) or
///   `E: Into<BoxError>` (`BoxError`, `String`, `&str`, `anyhow::Error`), or a plain `T`. A
///   `ToolResultBlock` is the result (answering this call's tool use), a `Vec<ToolResultContent>`
///   is the content of a successful result, and any other `T: Serialize` is shaped as
///   `FunctionTool` shapes a callback's value: a string becomes text, an object JSON content, and
///   so on. An `Err` becomes an error result with the text `Error: <message>`, except an
///   interrupt from `ctx.interrupt(..)?`, which pauses the agent.
/// - **Dependencies.** The generated input struct uses the `serde` and `schemars` that strands
///   re-exports. A parameter of a type of your own derives `serde::Deserialize` and
///   `schemars::JsonSchema` itself, so add `serde` and `schemars = "1"` (the major version
///   strands uses) to your `Cargo.toml`.
/// - **Paths.** Generated code names `::strands`; a crate that re-exports strands sets
///   `#[tool(crate = "path::to::strands")]`.
///
/// ```
/// use serde_json::json;
/// use strands::{Tool, ToolContext, ToolError, tool};
///
/// /// Get the current weather for a city.
/// #[tool]
/// async fn get_weather(
///     /// City name, for example "Seattle".
///     city: String,
///     /// Days to forecast.
///     days: Option<u32>,
///     #[tool(context)] ctx: &ToolContext,
/// ) -> Result<String, ToolError> {
///     let _ = ctx.tool_use();
///     Ok(format!("Sunny in {city} for {} days", days.unwrap_or(1)))
/// }
///
/// let spec = GetWeather.tool_spec();
/// assert_eq!(spec.name, "get_weather");
/// assert_eq!(spec.description, "Get the current weather for a city.");
/// assert_eq!(
///     spec.input_schema,
///     Some(json!({
///         "type": "object",
///         "properties": {
///             "city": {"type": "string", "description": "City name, for example \"Seattle\"."},
///             "days": {"type": ["integer", "null"], "description": "Days to forecast.", "minimum": 0}
///         },
///         "required": ["city"],
///         "additionalProperties": false
///     }))
/// );
/// ```
#[proc_macro_attribute]
pub fn tool(attr: TokenStream, item: TokenStream) -> TokenStream {
    tool_fn::expand(attr.into(), item.into()).into()
}

/// Generates tools from the `#[tool]` methods of an `impl` block, for tools with state.
///
/// Each `#[tool]` method takes `&self` and follows the [`macro@tool`] rules for its name,
/// description, parameters, context and return value. For a method `check_stock` the macro
/// generates `check_stock_tool(self: &Arc<Self>) -> impl Tool`, a tool holding the `Arc` that
/// calls the method, with the method's visibility, and `tools(self: &Arc<Self>) ->
/// Vec<ToolSource>` with every tool of the block, in order. `#[tools(crate = "..")]` sets the
/// strands path.
///
/// ```
/// use std::sync::Arc;
/// use strands::{Tool, ToolError, tools};
///
/// struct Inventory {
///     stock: u32,
/// }
///
/// #[tools]
/// impl Inventory {
///     /// Look up stock for a product.
///     #[tool]
///     async fn check_stock(&self, sku: String) -> Result<u32, ToolError> {
///         let _ = sku;
///         Ok(self.stock)
///     }
/// }
///
/// let inventory = Arc::new(Inventory { stock: 3 });
/// assert_eq!(inventory.check_stock_tool().name(), "check_stock");
/// assert_eq!(inventory.tools().len(), 1);
/// ```
#[proc_macro_attribute]
pub fn tools(attr: TokenStream, item: TokenStream) -> TokenStream {
    tools_impl::expand(attr.into(), item.into()).into()
}
