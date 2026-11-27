//! The `fileEditor` tool: views, creates and edits files through a sandbox. Deprecated in favour
//! of the focused [`edit`](super::edit), [`read`](super::read) and [`write`](super::write) tools.

use std::sync::Arc;

use serde_json::json;

use super::input::InputReader;
use super::{js_number_text, resolve_sandbox};
use crate::error::Error;
use crate::sandbox::Sandbox;
use crate::tools::{FunctionTool, ToolError};
use crate::types::{JsonSchema, JsonValue};

const SNIPPET_LINES: usize = 4;
const DEFAULT_MAX_FILE_SIZE: usize = 1_048_576;
const MAX_DIRECTORY_DEPTH: usize = 2;
const COMMANDS: [&str; 4] = ["view", "create", "str_replace", "insert"];

/// The description of the `fileEditor` tool shown to the model (`DEFAULT_FILE_EDITOR_DESCRIPTION`).
pub const DEFAULT_FILE_EDITOR_DESCRIPTION: &str = "Filesystem editor tool for viewing, creating, and editing files. Supports view (with line ranges), create, str_replace, and insert operations. Files must use absolute paths.";

/// Options for [`make_file_editor`] (`MakeFileEditorOptions`).
#[derive(Clone, Default, bon::Builder)]
#[builder(on(String, into))]
pub struct MakeFileEditorOptions {
    /// The sandbox holding the files. `None` uses the calling agent's
    /// [`sandbox`](crate::ToolAgent::sandbox).
    pub sandbox: Option<Arc<dyn Sandbox>>,
    /// The tool name; `fileEditor` when absent.
    pub name: Option<String>,
    /// The tool description; [`DEFAULT_FILE_EDITOR_DESCRIPTION`] when absent.
    pub description: Option<String>,
}

impl std::fmt::Debug for MakeFileEditorOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MakeFileEditorOptions")
            .field("sandbox", &self.sandbox.is_some())
            .field("name", &self.name)
            .field("description", &self.description)
            .finish()
    }
}

fn input_schema() -> JsonSchema {
    json!({
        "type": "object",
        "properties": {
            "command": {
                "type": "string",
                "enum": COMMANDS,
                "description": "The operation to perform: `view`, `create`, `str_replace`, `insert`."
            },
            "path": {"type": "string", "description": "Absolute path to the file or directory."},
            "file_text": {"description": "Content for new file (required for create command).", "type": "string"},
            "view_range": {
                "description": "Line range to view [start, end]. 1-indexed. End can be -1 for end of file.",
                "type": "array",
                "prefixItems": [{"type": "number"}, {"type": "number"}],
                "items": false,
                "minItems": 2,
                "maxItems": 2
            },
            "old_str": {
                "description": "Exact string to find and replace (required for str_replace command).",
                "type": "string"
            },
            "new_str": {
                "description": "Replacement string (for str_replace and insert commands).",
                "type": "string"
            },
            "insert_line": {
                "description": "Line number where text should be inserted (0-indexed, required for insert command).",
                "type": "number"
            }
        },
        "required": ["command", "path"],
        "additionalProperties": false
    })
}

/// The default `fileEditor` tool, working through the calling agent's sandbox.
#[deprecated(note = "use the focused `edit`, `read` and `write` tools")]
#[must_use]
pub fn file_editor() -> FunctionTool {
    #[allow(deprecated, reason = "the default instance of the deprecated factory")]
    make_file_editor(MakeFileEditorOptions::default())
}

/// Creates a file editor tool with the commands `view` (a file with optional
/// line range, or a directory two levels deep), `create` (never overwrites), `str_replace`
/// (`old_str` must appear exactly once) and `insert` (after a 0-indexed line).
#[deprecated(note = "use the focused `edit`, `read` and `write` tools")]
#[must_use]
pub fn make_file_editor(options: MakeFileEditorOptions) -> FunctionTool {
    let name = options.name.unwrap_or_else(|| "fileEditor".to_owned());
    let description = options
        .description
        .unwrap_or_else(|| DEFAULT_FILE_EDITOR_DESCRIPTION.to_owned());
    let bound = options.sandbox;
    FunctionTool::builder(name, description)
        .input_schema(input_schema())
        .callback(move |input, context| {
            let sandbox = resolve_sandbox(bound.as_ref(), &context);
            async move { run(sandbox.as_ref(), &input).await }
        })
}

struct Input<'a> {
    command: &'a str,
    path: String,
    file_text: Option<&'a str>,
    view_range: Option<(f64, f64)>,
    old_str: Option<&'a str>,
    new_str: Option<&'a str>,
    insert_line: Option<f64>,
}

fn parse(input: &JsonValue) -> Result<Input<'_>, ToolError> {
    let mut reader = InputReader::new(input);
    let command = reader.one_of("command", &COMMANDS);
    let path = reader.string("path");
    let file_text = reader.optional_string("file_text");
    let view_range = match reader.get("view_range") {
        None => None,
        Some(JsonValue::Array(items)) if items.len() == 2 => match (items[0].as_f64(), items[1].as_f64()) {
            (Some(start), Some(end)) => Some((start, end)),
            _ => {
                reader.issue("view_range", "Invalid input: expected [number, number]");
                None
            }
        },
        Some(_) => {
            reader.issue("view_range", "Invalid input: expected [number, number]");
            None
        }
    };
    let old_str = reader.optional_string("old_str");
    let new_str = reader.optional_string("new_str");
    let insert_line = reader.optional_number("insert_line");
    reader.finish()?;
    let path = path.unwrap_or_default();
    Ok(Input {
        command: command.unwrap_or_default(),
        path: path.trim_end_matches(['/', '\\']).to_owned(),
        file_text,
        view_range,
        old_str,
        new_str,
        insert_line,
    })
}

async fn run(sandbox: &dyn Sandbox, input: &JsonValue) -> Result<JsonValue, ToolError> {
    let input = parse(input)?;
    let path = input.path.as_str();
    let text = match input.command {
        "view" => view(sandbox, path, input.view_range).await?,
        "create" => {
            let Some(file_text) = input.file_text else {
                return Err(ToolError::msg("Parameter `file_text` is required for command: create"));
            };
            create(sandbox, path, file_text).await?
        }
        "str_replace" => {
            let Some(old_str) = input.old_str else {
                return Err(ToolError::msg(
                    "Parameter `old_str` is required for command: str_replace",
                ));
            };
            str_replace(sandbox, path, old_str, input.new_str).await?
        }
        _ => {
            let (Some(insert_line), Some(new_str)) = (input.insert_line, input.new_str) else {
                return Err(ToolError::msg(
                    "Parameters `insert_line` and `new_str` are required for command: insert",
                ));
            };
            insert(sandbox, path, insert_line, new_str).await?
        }
    };
    Ok(text.into())
}

fn validate_path(path: &str) -> Result<(), ToolError> {
    if !std::path::Path::new(path).is_absolute() {
        let suggested = std::env::current_dir()
            .map(|dir| dir.join(path).display().to_string())
            .unwrap_or_else(|_| path.to_owned());
        return Err(ToolError::msg(format!(
            "The path {path} is not an absolute path, it should start with `/`. Maybe you meant {suggested}?"
        )));
    }
    if path.split(['/', '\\']).any(|segment| segment == "..") {
        return Err(ToolError::msg("Invalid path: path traversal is not allowed"));
    }
    Ok(())
}

/// Whether the path exists and is a directory, from a listing of its parent. A missing parent or
/// entry is `None`; other failures are errors, so they are not mistaken for absence.
async fn probe(sandbox: &dyn Sandbox, path: &str) -> Result<Option<bool>, ToolError> {
    let normalized = path.replace('\\', "/");
    let (parent, name) = normalized.rsplit_once('/').unwrap_or(("", normalized.as_str()));
    let parent = if parent.is_empty() { "/" } else { parent };
    match sandbox.list_files(parent).await {
        Ok(entries) => Ok(entries
            .into_iter()
            .find(|entry| entry.name == name)
            .map(|entry| entry.is_dir.unwrap_or(false))),
        Err(Error::SandboxPathNotFound(_)) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn not_found(path: &str) -> ToolError {
    ToolError::msg(format!("The path {path} does not exist. Please provide a valid path."))
}

fn directory_rejected(path: &str) -> ToolError {
    ToolError::msg(format!(
        "The path {path} is a directory and only the `view` command can be used on directories"
    ))
}

fn check_size(content: &str) -> Result<(), ToolError> {
    if content.len() > DEFAULT_MAX_FILE_SIZE {
        return Err(ToolError::msg(format!(
            "File size ({} bytes) exceeds maximum allowed size ({DEFAULT_MAX_FILE_SIZE} bytes)",
            content.len()
        )));
    }
    Ok(())
}

/// The content as `cat -n` output: tabs expanded, numbers padded to 6, then two spaces.
fn make_output(content: &str, descriptor: &str, init_line: usize) -> String {
    let numbered: Vec<String> = content
        .replace('\t', "        ")
        .split('\n')
        .enumerate()
        .map(|(index, line)| format!("{:>6}  {line}", index + init_line))
        .collect();
    format!(
        "Here's the result of running `cat -n` on {descriptor}:\n{}\n",
        numbered.join("\n")
    )
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "a whole line index already checked to be in range"
)]
fn index(value: f64) -> usize {
    value.trunc() as usize
}

fn apply_view_range(content: &str, view_range: Option<(f64, f64)>) -> Result<(String, usize), ToolError> {
    let Some((start, end)) = view_range else {
        return Ok((content.to_owned(), 1));
    };
    let lines: Vec<&str> = content.split('\n').collect();
    #[allow(clippy::cast_precision_loss, reason = "line counts are far below 2^53")]
    let n_lines = lines.len() as f64;
    let (start_text, end_text) = (js_number_text(start), js_number_text(end));
    if start < 1.0 || start > n_lines {
        return Err(ToolError::msg(format!(
            "Invalid `view_range`: [{start_text}, {end_text}]. Its first element `{start_text}` should be within the range of lines of the file: [1, {}]",
            lines.len()
        )));
    }
    if end != -1.0 && end > n_lines {
        return Err(ToolError::msg(format!(
            "Invalid `view_range`: [{start_text}, {end_text}]. Its second element `{end_text}` should be smaller than the number of lines in the file: `{}`",
            lines.len()
        )));
    }
    if end != -1.0 && end < start {
        return Err(ToolError::msg(format!(
            "Invalid `view_range`: [{start_text}, {end_text}]. Its second element `{end_text}` should be larger or equal than its first `{start_text}`"
        )));
    }
    let first = index(start) - 1;
    let last = if end == -1.0 {
        lines.len()
    } else {
        index(end).max(first)
    };
    Ok((lines[first..last].join("\n"), index(start)))
}

async fn list_directory(sandbox: &dyn Sandbox, dir: &str) -> String {
    let mut items = Vec::new();
    let mut pending = vec![(dir.to_owned(), String::new(), 0)];
    while let Some((current, prefix, depth)) = pending.pop() {
        let Ok(entries) = sandbox.list_files(&current).await else {
            continue;
        };
        for entry in entries {
            if entry.name.starts_with('.') {
                continue;
            }
            let relative = if prefix.is_empty() {
                entry.name.clone()
            } else {
                format!("{prefix}/{}", entry.name)
            };
            if entry.is_dir == Some(true) && depth < MAX_DIRECTORY_DEPTH {
                pending.push((format!("{current}/{}", entry.name), relative.clone(), depth + 1));
            }
            items.push(relative);
        }
    }
    items.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    format!(
        "Here's the files and directories up to 2 levels deep in {dir}, excluding hidden items:\n{}\n",
        items.join("\n")
    )
}

async fn view(sandbox: &dyn Sandbox, path: &str, view_range: Option<(f64, f64)>) -> Result<String, ToolError> {
    validate_path(path)?;
    let Some(is_dir) = probe(sandbox, path).await? else {
        return Err(not_found(path));
    };
    if is_dir {
        if view_range.is_some() {
            return Err(ToolError::msg(
                "The `view_range` parameter is not allowed when `path` points to a directory.",
            ));
        }
        return Ok(list_directory(sandbox, path).await);
    }
    let content = sandbox.read_text(path).await?;
    check_size(&content)?;
    let (content, init_line) = apply_view_range(&content, view_range)?;
    Ok(make_output(&content, path, init_line))
}

async fn create(sandbox: &dyn Sandbox, path: &str, file_text: &str) -> Result<String, ToolError> {
    validate_path(path)?;
    if probe(sandbox, path).await?.is_some() {
        return Err(ToolError::msg(format!(
            "File already exists at: {path}. Cannot overwrite files using command `create`."
        )));
    }
    sandbox.write_text(path, file_text).await?;
    Ok(format!("File created successfully at: {path}"))
}

/// The edited file's text, after the existence, directory and size checks.
async fn read_editable(sandbox: &dyn Sandbox, path: &str) -> Result<String, ToolError> {
    validate_path(path)?;
    match probe(sandbox, path).await? {
        None => return Err(not_found(path)),
        Some(true) => return Err(directory_rejected(path)),
        Some(false) => {}
    }
    let content = sandbox.read_text(path).await?;
    check_size(&content)?;
    Ok(content)
}

fn line_count(text: &str) -> usize {
    text.matches('\n').count() + 1
}

async fn str_replace(
    sandbox: &dyn Sandbox,
    path: &str,
    old_str: &str,
    new_str: Option<&str>,
) -> Result<String, ToolError> {
    let content = read_editable(sandbox, path).await?;
    if old_str.is_empty() {
        return Err(ToolError::msg(
            "No replacement was performed, old_str must not be empty.",
        ));
    }
    let replacement = new_str.unwrap_or_default();
    let offsets: Vec<usize> = content.match_indices(old_str).map(|(offset, _)| offset).collect();
    let [offset] = offsets.as_slice() else {
        if offsets.is_empty() {
            return Err(ToolError::msg(format!(
                "No replacement was performed, old_str `{old_str}` did not appear verbatim in {path}."
            )));
        }
        let lines: Vec<usize> = offsets.iter().map(|offset| line_count(&content[..*offset])).collect();
        return Err(ToolError::msg(format!(
            "No replacement was performed. Multiple occurrences of old_str `{old_str}` in lines {}. Please ensure it is unique",
            serde_json::to_string(&lines)?
        )));
    };
    let offset = *offset;
    let new_content = format!(
        "{}{replacement}{}",
        &content[..offset],
        &content[offset + old_str.len()..]
    );
    let replacement_line = line_count(&content[..offset]) - 1;
    let new_lines: Vec<&str> = new_content.split('\n').collect();
    let start = replacement_line.saturating_sub(SNIPPET_LINES);
    let end = (replacement_line + SNIPPET_LINES + line_count(replacement) + 1)
        .saturating_sub(line_count(old_str))
        .min(new_lines.len());
    let snippet = new_lines[start..end.max(start)].join("\n");
    sandbox.write_text(path, &new_content).await?;
    Ok(format!(
        "The file {path} has been edited. {}Review the changes and make sure they are as expected. Edit the file again if necessary.",
        make_output(&snippet, &format!("a snippet of {path}"), start + 1)
    ))
}

async fn insert(sandbox: &dyn Sandbox, path: &str, insert_line: f64, new_str: &str) -> Result<String, ToolError> {
    let content = read_editable(sandbox, path).await?;
    let file_lines: Vec<&str> = content.split('\n').collect();
    #[allow(clippy::cast_precision_loss, reason = "line counts are far below 2^53")]
    if insert_line < 0.0 || insert_line > file_lines.len() as f64 {
        return Err(ToolError::msg(format!(
            "Invalid `insert_line` parameter: {}. It should be within the range of lines of the file: [0, {}]",
            js_number_text(insert_line),
            file_lines.len()
        )));
    }
    let at = index(insert_line);
    let new_str_lines: Vec<&str> = new_str.split('\n').collect();
    let new_file_lines: Vec<&str> = if content.is_empty() {
        new_str_lines.clone()
    } else {
        [&file_lines[..at], new_str_lines.as_slice(), &file_lines[at..]].concat()
    };
    let new_content = new_file_lines.join("\n");
    let start = at.saturating_sub(SNIPPET_LINES);
    let end = (at + new_str_lines.len() + SNIPPET_LINES).min(new_file_lines.len());
    let snippet = new_file_lines[start..end.max(start)].join("\n");
    sandbox.write_text(path, &new_content).await?;
    Ok(format!(
        "The file {path} has been edited. {}Review the changes and make sure they are as expected (correct indentation, no duplicate lines, etc). Edit the file again if necessary.",
        make_output(&snippet, "a snippet of the edited file", start + 1)
    ))
}

#[cfg(test)]
#[allow(deprecated, reason = "tests the deprecated tool")]
mod tests;
