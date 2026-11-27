//! The `notebook` tool: text notebooks kept in the agent's app state under `notebooks`, so they
//! persist with the agent.

use serde_json::json;

use super::input::{InputReader, type_name};
use super::js_number_text;
use crate::error::{Error, Result};
use crate::state_store::StateStore;
use crate::tools::{FunctionTool, ToolError};
use crate::types::{JsonObject, JsonSchema, JsonValue};

const DEFAULT_MAX_NOTEBOOK_SIZE_BYTES: usize = 1_048_576;
const MODES: [&str; 5] = ["create", "list", "read", "write", "clear"];
const STATE_KEY: &str = "notebooks";

/// The description of the `notebook` tool shown to the model.
pub(crate) const NOTEBOOK_DESCRIPTION: &str = "Manages text notebooks for note-taking and documentation. Supports create, list, read, write (append, replace, or insert), and clear operations. In write mode: newStr alone appends to the end; newStr with oldStr replaces matching text; newStr with insertLine inserts at a position. A write only succeeds on a notebook that already exists: use list to check, or create to start a new one (create replaces any existing content). Notebooks persist within the agent invocation.";

const WRITE_REQUIREMENTS: &str = "Write operation requires newStr, optionally with oldStr for replacement or insertLine for insertion; oldStr and insertLine cannot be combined";

/// Options for [`make_notebook`] (`MakeNotebookOptions`).
#[derive(Debug, Clone, Default, bon::Builder)]
#[builder(on(String, into))]
pub struct MakeNotebookOptions {
    /// The tool name; `notebook` when absent.
    pub name: Option<String>,
    /// The tool description; the default notebook description when absent.
    pub description: Option<String>,
    /// The largest notebook, in UTF-8 bytes; 1 MiB when absent.
    pub max_notebook_size_bytes: Option<usize>,
}

fn input_schema() -> JsonSchema {
    json!({
        "type": "object",
        "properties": {
            "mode": {
                "type": "string",
                "enum": MODES,
                "description": "The operation to perform: `create`, `list`, `read`, `write`, `clear`."
            },
            "name": {"description": "Name of the notebook to operate on. Defaults to \"default\".", "type": "string"},
            "newStr": {
                "description": "Text to append, or the new string for replacement and insertion operations.",
                "type": "string"
            },
            "readRange": {
                "description": "Optional parameter of `read` command. Line range to show [start, end]. Supports negative indices.",
                "type": "array",
                "items": {"type": "number"}
            },
            "oldStr": {"description": "String to replace in write mode when doing text replacement.", "type": "string"},
            "insertLine": {
                "description": "Line number (int) or search text (str) for insertion point in write mode.\nSupports negative indices.",
                "type": ["string", "number"]
            }
        },
        "required": ["mode"],
        "additionalProperties": false
    })
}

/// The default `notebook` tool (`notebook`).
#[must_use]
pub fn notebook() -> FunctionTool {
    build(
        "notebook".to_owned(),
        NOTEBOOK_DESCRIPTION.to_owned(),
        DEFAULT_MAX_NOTEBOOK_SIZE_BYTES,
    )
}

/// Creates a notebook tool with the modes `create` (replaces any content),
/// `list`, `read` (optionally a line range, negative indices from the end), `write` (append,
/// replace `oldStr`, or insert after `insertLine`, a line number or search text) and `clear`.
///
/// ```
/// use strands::vended_tools::notebook::{MakeNotebookOptions, make_notebook};
///
/// let scratchpad = make_notebook(
///     MakeNotebookOptions::builder().name("scratchpad").max_notebook_size_bytes(65_536).build(),
/// )?;
/// assert_eq!(strands::Tool::name(&scratchpad), "scratchpad");
/// # Ok::<(), strands::Error>(())
/// ```
///
/// # Errors
///
/// When `name` is empty or `max_notebook_size_bytes` is 0.
pub fn make_notebook(options: MakeNotebookOptions) -> Result<FunctionTool> {
    let name = options.name.unwrap_or_else(|| "notebook".to_owned());
    if name.is_empty() {
        return Err(Error::other("name must be a non-empty string"));
    }
    let max_size = options
        .max_notebook_size_bytes
        .unwrap_or(DEFAULT_MAX_NOTEBOOK_SIZE_BYTES);
    if max_size < 1 {
        return Err(Error::other("maxNotebookSizeBytes must be a positive integer"));
    }
    let description = options.description.unwrap_or_else(|| NOTEBOOK_DESCRIPTION.to_owned());
    Ok(build(name, description, max_size))
}

fn build(name: String, description: String, max_size: usize) -> FunctionTool {
    FunctionTool::builder(name, description)
        .input_schema(input_schema())
        .callback(move |input, context| {
            let state = context.agent().app_state().clone();
            async move { run(&state, &input, max_size).map(JsonValue::String) }
        })
}

#[derive(Clone, Copy)]
enum InsertLine<'a> {
    Text(&'a str),
    Number(f64),
}

struct Input<'a> {
    mode: &'a str,
    name: &'a str,
    new_str: Option<&'a str>,
    read_range: Option<Vec<f64>>,
    old_str: Option<&'a str>,
    insert_line: Option<InsertLine<'a>>,
}

fn parse(input: &JsonValue) -> std::result::Result<Input<'_>, ToolError> {
    let mut reader = InputReader::new(input);
    let mode = reader.one_of("mode", &MODES);
    let name = reader.optional_string("name");
    let new_str = reader.optional_string("newStr");
    let read_range = match reader.get("readRange") {
        None => None,
        Some(JsonValue::Array(items)) => {
            let numbers: Option<Vec<f64>> = items.iter().map(JsonValue::as_f64).collect();
            if numbers.is_none() {
                reader.issue("readRange", "Invalid input: expected array of numbers");
            }
            numbers
        }
        Some(other) => {
            let message = format!("Invalid input: expected array, received {}", type_name(Some(other)));
            reader.issue("readRange", message);
            None
        }
    };
    let old_str = reader.optional_string("oldStr");
    let insert_line = match reader.get("insertLine") {
        None => None,
        Some(JsonValue::String(text)) => Some(InsertLine::Text(text)),
        Some(value) => match value.as_f64() {
            Some(number) => Some(InsertLine::Number(number)),
            None => {
                reader.issue("insertLine", "Invalid input: expected string | number");
                None
            }
        },
    };
    if mode == Some("write") {
        let has_replacement = old_str.is_some() && new_str.is_some();
        let has_insertion = insert_line.is_some() && new_str.is_some();
        let has_append = old_str.is_none() && insert_line.is_none() && new_str.is_some();
        let ambiguous = old_str.is_some() && insert_line.is_some();
        if !(has_replacement || has_insertion || has_append) || ambiguous {
            reader.root_issue(WRITE_REQUIREMENTS);
        }
    }
    reader.finish()?;
    Ok(Input {
        mode: mode.unwrap_or_default(),
        name: name.unwrap_or("default"),
        new_str,
        read_range,
        old_str,
        insert_line,
    })
}

fn load(state: &StateStore) -> std::result::Result<JsonObject, ToolError> {
    let mut notebooks = match state.get_value(STATE_KEY) {
        None | Some(JsonValue::Null) => JsonObject::new(),
        Some(JsonValue::Object(notebooks)) => {
            if notebooks.values().any(|value| !value.is_string()) {
                return Err(ToolError::msg(
                    "Malformed notebooks state: keys and values must be strings",
                ));
            }
            notebooks
        }
        Some(_) => return Err(ToolError::msg("Malformed notebooks state: expected a plain object")),
    };
    if notebooks.is_empty() {
        notebooks.insert("default".to_owned(), JsonValue::String(String::new()));
    }
    Ok(notebooks)
}

fn content<'a>(notebooks: &'a JsonObject, name: &str) -> std::result::Result<&'a str, ToolError> {
    notebooks
        .get(name)
        .and_then(JsonValue::as_str)
        .ok_or_else(|| ToolError::msg(format!("Notebook '{name}' not found")))
}

fn run(state: &StateStore, input: &JsonValue, max_size: usize) -> std::result::Result<String, ToolError> {
    let input = parse(input)?;
    let mut notebooks = load(state)?;
    let name = input.name;
    let result = match input.mode {
        "create" => create(&mut notebooks, name, input.new_str),
        "list" => list(&notebooks),
        "read" => read(&notebooks, name, input.read_range.as_deref())?,
        "write" => write(&mut notebooks, name, input.old_str, input.new_str, input.insert_line)?,
        _ => clear(&mut notebooks, name)?,
    };
    if matches!(input.mode, "create" | "write") {
        let size = notebooks.get(name).and_then(JsonValue::as_str).map_or(0, str::len);
        if size > max_size {
            return Err(ToolError::msg(format!(
                "Notebook '{name}' content ({size} bytes) would exceed maximum of {max_size} bytes"
            )));
        }
    }
    if matches!(input.mode, "create" | "write" | "clear") {
        state.set(STATE_KEY, JsonValue::Object(notebooks))?;
    }
    Ok(result)
}

fn create(notebooks: &mut JsonObject, name: &str, new_str: Option<&str>) -> String {
    notebooks.insert(
        name.to_owned(),
        JsonValue::String(new_str.unwrap_or_default().to_owned()),
    );
    let described = if new_str.is_some_and(|text| !text.is_empty()) {
        " with specified content"
    } else {
        " (empty)"
    };
    format!("Created notebook '{name}'{described}")
}

fn list(notebooks: &JsonObject) -> String {
    let details: Vec<String> = notebooks
        .iter()
        .map(|(name, content)| {
            let content = content.as_str().unwrap_or_default();
            if content.is_empty() {
                format!("- {name}: Empty")
            } else {
                format!("- {name}: {} lines", content.split('\n').count())
            }
        })
        .collect();
    format!("Available notebooks:\n{}", details.join("\n"))
}

fn read(notebooks: &JsonObject, name: &str, read_range: Option<&[f64]>) -> std::result::Result<String, ToolError> {
    let content = content(notebooks, name)?;
    let Some(read_range) = read_range else {
        if content.is_empty() {
            return Ok(format!("Notebook '{name}' is empty"));
        }
        return Ok(content.to_owned());
    };
    let lines: Vec<&str> = content.split('\n').collect();
    let (Some(&first), Some(&second)) = (read_range.first(), read_range.get(1)) else {
        return Err(ToolError::msg(
            "`readRange` must be a list of two integers: `[start, end]`",
        ));
    };
    #[allow(clippy::cast_precision_loss, reason = "line counts are far below 2^53")]
    let count = lines.len() as f64;
    let start = if first < 0.0 { count + first + 1.0 } else { first };
    let end = if second < 0.0 { count + second + 1.0 } else { second };
    let mut selected = Vec::new();
    let mut line_number = start.max(1.0);
    while line_number <= end.min(count) {
        let line = if line_number.fract() == 0.0 {
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "whole and in range"
            )]
            lines[line_number as usize - 1]
        } else {
            "undefined"
        };
        selected.push(format!("{}: {line}", js_number_text(line_number)));
        line_number += 1.0;
    }
    if selected.is_empty() {
        return Ok(format!(
            "No lines found in range [{}, {}]. Notebook '{name}' has {} line(s).",
            js_number_text(first),
            js_number_text(second),
            lines.len()
        ));
    }
    Ok(selected.join("\n"))
}

fn write(
    notebooks: &mut JsonObject,
    name: &str,
    old_str: Option<&str>,
    new_str: Option<&str>,
    insert_line: Option<InsertLine<'_>>,
) -> std::result::Result<String, ToolError> {
    let current = content(notebooks, name)?.to_owned();
    let Some(new_str) = new_str else {
        return Err(ToolError::msg("Invalid write operation"));
    };
    let updated = match (old_str, insert_line) {
        (None, None) => {
            if new_str.is_empty() {
                return Ok(format!("No changes made to notebook '{name}'"));
            }
            let separator = if !current.is_empty() && !current.ends_with('\n') {
                "\n"
            } else {
                ""
            };
            notebooks.insert(
                name.to_owned(),
                JsonValue::String(format!("{current}{separator}{new_str}")),
            );
            return Ok(format!("Appended text to notebook '{name}'"));
        }
        (Some(old_str), _) => {
            if !current.contains(old_str) {
                return Err(ToolError::msg(format!(
                    "String '{old_str}' not found in notebook '{name}'"
                )));
            }
            notebooks.insert(
                name.to_owned(),
                JsonValue::String(current.replacen(old_str, new_str, 1)),
            );
            return Ok(format!("Replaced text in notebook '{name}'"));
        }
        (None, Some(insert_line)) => insert(&current, name, insert_line, new_str)?,
    };
    notebooks.insert(name.to_owned(), JsonValue::String(updated.0));
    Ok(format!(
        "Inserted text at line {} in notebook '{name}'",
        js_number_text(updated.1 + 2.0)
    ))
}

/// The content with `new_str` inserted after `insert_line`, and the line number inserted after.
fn insert(
    current: &str,
    name: &str,
    insert_line: InsertLine<'_>,
    new_str: &str,
) -> std::result::Result<(String, f64), ToolError> {
    let mut lines: Vec<&str> = current.split('\n').collect();
    #[allow(clippy::cast_precision_loss, reason = "line counts are far below 2^53")]
    let count = lines.len() as f64;
    let line_number = match insert_line {
        InsertLine::Text(text) => match lines.iter().position(|line| line.contains(text)) {
            #[allow(clippy::cast_precision_loss, reason = "line counts are far below 2^53")]
            Some(index) => index as f64,
            None => {
                return Err(ToolError::msg(format!("Text '{text}' not found in notebook '{name}'")));
            }
        },
        InsertLine::Number(number) if number < 0.0 => count + number,
        InsertLine::Number(number) => number - 1.0,
    };
    if line_number < -1.0 || line_number > count {
        return Err(ToolError::msg("Line number out of range"));
    }
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "checked to be in range"
    )]
    let at = ((line_number + 1.0).trunc() as usize).min(lines.len());
    lines.insert(at, new_str);
    Ok((lines.join("\n"), line_number))
}

fn clear(notebooks: &mut JsonObject, name: &str) -> std::result::Result<String, ToolError> {
    content(notebooks, name)?;
    notebooks.insert(name.to_owned(), JsonValue::String(String::new()));
    Ok(format!("Cleared notebook '{name}'"))
}

#[cfg(test)]
mod tests;
