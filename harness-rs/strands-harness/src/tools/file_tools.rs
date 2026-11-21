//! Filesystem tools `read`, `write` and `edit`, and the harness `shell`.
//!
//! The file tools route file access through the calling agent's
//! [`sandbox`](strands::ToolAgent::sandbox), so they behave the same against host and container
//! filesystems. Their texts and limits are the harness's, which differ from the SDK's vended
//! `read`/`write`/`edit`. `shell` is the SDK's stateless sandbox shell
//! ([`strands::vended_tools::shell::make_shell`]).

use serde_json::json;
use strands::tools::{FunctionTool, ToolContext, ToolError};
use strands::types::{
    DocumentBlock, DocumentFormat, DocumentSource, ImageBlock, ImageFormat, ImageSource, JsonSchema, JsonValue,
    ToolResultContent,
};
use strands::vended_tools::shell::{MakeShellOptions, make_shell};

const READ_DEFAULT_LIMIT: f64 = 2000.0;

const IMAGE_EXTENSIONS: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];

const PNG: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG: &[u8] = &[0xff, 0xd8, 0xff];
const GIF87A: &[u8] = b"GIF87a";
const GIF89A: &[u8] = b"GIF89a";

/// The `read` tool description (`READ_DESCRIPTION`).
pub const READ_DESCRIPTION: &str = concat!(
    "Read a file. Text returns `cat -n` style numbered lines so you can cite `path:line`; images ",
    "(png/jpg/jpeg/gif/webp) and binary documents (pdf/doc/docx/xls/xlsx) return media you can view directly. ",
    "Text defaults to the first 2000 lines; use offset/limit to page through larger files."
);

/// The `write` tool description.
pub const WRITE_DESCRIPTION: &str =
    "Write a file, creating it or overwriting it. Use `edit` for surgical changes to a large file.";

/// The `edit` tool description.
pub const EDIT_DESCRIPTION: &str = "Replace an exact string in a file. `old_str` must appear exactly once.";

fn read_schema() -> JsonSchema {
    json!({
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Absolute path to the file."},
            "offset": {
                "description": "1-indexed line to start from. Defaults to the first line. Text files only.",
                "type": "number"
            },
            "limit": {
                "description": "Maximum number of lines to return. Defaults to 2000. Text files only.",
                "type": "number"
            }
        },
        "required": ["path"],
        "additionalProperties": false
    })
}

fn write_schema() -> JsonSchema {
    json!({
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Absolute path to the file."},
            "content": {"type": "string", "description": "The full file content to write."}
        },
        "required": ["path", "content"],
        "additionalProperties": false
    })
}

fn edit_schema() -> JsonSchema {
    json!({
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Absolute path to the file."},
            "old_str": {"type": "string", "description": "Exact text to find. Must be unique within the file."},
            "new_str": {"type": "string", "description": "Replacement text."}
        },
        "required": ["path", "old_str", "new_str"],
        "additionalProperties": false
    })
}

/// The harness `read` tool.
///
/// `media: false` is for a model that rejects image and document blocks: `read` then describes
/// those files in text instead. Text files come back as `cat -n` style numbered lines, the first
/// 2000 by default; images are checked against their signature, so a mislabeled file is an error
/// rather than an image block that would poison the history.
///
/// ```
/// use strands::Tool;
/// use strands_harness::tools::file_tools::read_tool;
///
/// let read = read_tool(true);
/// assert_eq!(read.name(), "read");
/// ```
#[must_use]
pub fn read_tool(media: bool) -> FunctionTool {
    FunctionTool::builder("read", READ_DESCRIPTION)
        .input_schema(read_schema())
        .callback(move |input, context| async move { read(&input, &context, media).await })
}

/// The harness `write` tool (`write`): writes the whole file through the agent's sandbox and
/// reports the line count.
#[must_use]
pub fn write_tool() -> FunctionTool {
    FunctionTool::builder("write", WRITE_DESCRIPTION)
        .input_schema(write_schema())
        .callback(|input, context| async move { write(&input, &context).await })
}

/// The harness `edit` tool (`edit`): replaces `old_str`, which must appear exactly once, with
/// `new_str`.
#[must_use]
pub fn edit_tool() -> FunctionTool {
    FunctionTool::builder("edit", EDIT_DESCRIPTION)
        .input_schema(edit_schema())
        .callback(|input, context| async move { edit(&input, &context).await })
}

/// The harness `shell` built-in (`makeShell(builtinTools.shell)`): the SDK's stateless sandbox
/// shell, whose schema is `command` and `timeout` only. `description` replaces the SDK's default
/// description (`ShellConfig.description`).
///
/// # Errors
///
/// None in practice; [`make_shell`] fails only on an invalid default timeout, which this does
/// not set.
pub fn shell_tool(description: Option<String>) -> strands::Result<FunctionTool> {
    make_shell(MakeShellOptions {
        description,
        ..MakeShellOptions::default()
    })
}

fn string_field<'a>(input: &'a JsonValue, key: &str) -> Result<&'a str, ToolError> {
    input
        .get(key)
        .and_then(JsonValue::as_str)
        .ok_or_else(|| ToolError::msg(format!("Invalid input: expected string at \"{key}\".")))
}

fn number_field(input: &JsonValue, key: &str) -> Result<Option<f64>, ToolError> {
    match input.get(key) {
        None | Some(JsonValue::Null) => Ok(None),
        Some(value) => value
            .as_f64()
            .map(Some)
            .ok_or_else(|| ToolError::msg(format!("Invalid input: expected number at \"{key}\"."))),
    }
}

/// Accepts either platform's absolute form (POSIX `/`, Windows `\`, a drive letter with a
/// separator, or a UNC share): the path belongs to the sandbox, not the host.
fn validate_path(path: &str) -> Result<(), ToolError> {
    let bytes = path.as_bytes();
    let drive =
        bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'\\' | b'/');
    if !(path.starts_with('/') || path.starts_with('\\') || drive) {
        return Err(ToolError::msg(format!(
            "The path {path} is not absolute; it should start with '/' (or a drive letter or UNC share on Windows)."
        )));
    }
    if path.split(['/', '\\']).any(|segment| segment == "..") {
        return Err(ToolError::msg("Invalid path: path traversal is not allowed."));
    }
    Ok(())
}

fn file_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or_default()
}

fn extension(path: &str) -> String {
    let name = file_name(path);
    name.rfind('.')
        .map_or_else(String::new, |dot| name[dot + 1..].to_lowercase())
}

/// Bedrock accepts only alphanumerics, whitespace, hyphens, parentheses and square brackets in
/// document names, with no consecutive whitespace.
fn document_name(path: &str) -> String {
    let replaced: String = file_name(path)
        .chars()
        .map(|c| {
            let allowed = c.is_ascii_alphanumeric() || c.is_whitespace() || "-()[]".contains(c);
            if allowed { c } else { ' ' }
        })
        .collect();
    let collapsed = replaced.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        "document".to_owned()
    } else {
        collapsed
    }
}

fn sniff_image_format(data: &[u8]) -> Option<ImageFormat> {
    if data.starts_with(b"RIFF") && data.get(8..12) == Some(b"WEBP".as_slice()) {
        return Some(ImageFormat::Webp);
    }
    [
        (PNG, ImageFormat::Png),
        (JPEG, ImageFormat::Jpeg),
        (GIF87A, ImageFormat::Gif),
        (GIF89A, ImageFormat::Gif),
    ]
    .into_iter()
    .find(|(signature, _)| data.starts_with(signature))
    .map(|(_, format)| format)
}

fn image_format_name(format: ImageFormat) -> &'static str {
    match format {
        ImageFormat::Png => "png",
        ImageFormat::Gif => "gif",
        ImageFormat::Webp => "webp",
        _ => "jpeg",
    }
}

fn document_format(ext: &str) -> Option<DocumentFormat> {
    match ext {
        "pdf" => Some(DocumentFormat::Pdf),
        "doc" => Some(DocumentFormat::Doc),
        "docx" => Some(DocumentFormat::Docx),
        "xls" => Some(DocumentFormat::Xls),
        "xlsx" => Some(DocumentFormat::Xlsx),
        _ => None,
    }
}

fn media_placeholder(path: &str, kind: &str, format: &str, size: usize) -> String {
    format!(
        "[{kind} file: {path} ({format}, {size} bytes). This model cannot view {} files, so its contents are not shown. Use shell tools if the file has a text-extractable form.]",
        kind.to_lowercase()
    )
}

/// A number as text, whole numbers in the safe integer range without a fraction, or `undefined`.
fn js_text(value: Option<f64>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(value) if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 => format!("{value:.0}"),
        Some(value) => value.to_string(),
    }
}

/// `Array.prototype.slice` index resolution: truncates, counts a negative index from the end,
/// and clamps to `[0, len]`.
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    reason = "clamped to [0, len] before the cast"
)]
fn slice_index(index: f64, len: usize) -> usize {
    let len_f = len as f64;
    let index = if index.is_nan() { 0.0 } else { index.trunc() };
    let resolved = if index < 0.0 {
        (len_f + index).max(0.0)
    } else {
        index.min(len_f)
    };
    resolved as usize
}

async fn read(input: &JsonValue, context: &ToolContext, media: bool) -> Result<JsonValue, ToolError> {
    let path = string_field(input, "path")?;
    let offset = number_field(input, "offset")?;
    let limit = number_field(input, "limit")?;
    validate_path(path)?;
    let ext = extension(path);
    let sandbox = context.agent().sandbox();

    if IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        let bytes = sandbox.read_file(path).await?;
        let Some(format) = sniff_image_format(&bytes) else {
            return Err(ToolError::msg(format!(
                "{path} has a .{ext} extension but its {} bytes are not a png, jpeg, gif, or webp image. Identify it with `file`; if it is text, read it with `cat`.",
                bytes.len()
            )));
        };
        if !media {
            return Ok(media_placeholder(path, "Image", image_format_name(format), bytes.len()).into());
        }
        let block = ImageBlock::new(format, ImageSource::Bytes(bytes));
        return Ok(serde_json::to_value(ToolResultContent::Image(block))?);
    }

    if let Some(format) = document_format(&ext) {
        let bytes = sandbox.read_file(path).await?;
        if !media {
            return Ok(media_placeholder(path, "Document", &ext, bytes.len()).into());
        }
        let block = DocumentBlock::new(document_name(path), format, DocumentSource::Bytes(bytes));
        return Ok(serde_json::to_value(ToolResultContent::Document(block))?);
    }

    let content = sandbox.read_text(path).await?;
    Ok(numbered_window(&content, offset, limit).into())
}

#[allow(clippy::cast_precision_loss, reason = "line counts are far below 2^53")]
fn numbered_window(content: &str, offset: Option<f64>, limit: Option<f64>) -> String {
    let lines: Vec<&str> = content.split('\n').collect();
    let start_f = offset
        .filter(|offset| *offset != 0.0 && !offset.is_nan())
        .map_or(0.0, |offset| (offset - 1.0).max(0.0));
    let count = limit.unwrap_or(READ_DEFAULT_LIMIT);
    let start = slice_index(start_f, lines.len());
    let end = slice_index(start_f + count, lines.len());
    let window = lines.get(start..end.max(start)).unwrap_or_default();
    if window.is_empty() {
        return format!(
            "[File has {} lines; offset {} is past the end.]",
            lines.len(),
            js_text(offset)
        );
    }
    let mut numbered = window
        .iter()
        .enumerate()
        .map(|(index, line)| format!("{:>6}\t{line}", index + start + 1))
        .collect::<Vec<_>>()
        .join("\n");
    if start_f > 0.0 || start_f + count < lines.len() as f64 {
        numbered.push_str(&format!(
            "\n[Showing lines {}-{} of {}. Use offset/limit to read more.]",
            js_text(Some(start_f + 1.0)),
            js_text(Some(start_f + window.len() as f64)),
            lines.len()
        ));
    }
    numbered
}

async fn write(input: &JsonValue, context: &ToolContext) -> Result<JsonValue, ToolError> {
    let path = string_field(input, "path")?;
    let content = string_field(input, "content")?;
    validate_path(path)?;
    context.agent().sandbox().write_text(path, content).await?;
    let line_count = if content.is_empty() {
        0
    } else {
        content.split('\n').count()
    };
    Ok(format!("Wrote {line_count} lines to {path}.").into())
}

/// How many times `old` occurs in `content`; an empty `old` counts the gaps between UTF-16 code
/// units (one less than their number).
#[allow(clippy::cast_possible_wrap, reason = "file sizes are far below i64::MAX")]
fn occurrences(content: &str, old: &str) -> i64 {
    if old.is_empty() {
        return content.encode_utf16().count() as i64 - 1;
    }
    content.matches(old).count() as i64
}

async fn edit(input: &JsonValue, context: &ToolContext) -> Result<JsonValue, ToolError> {
    let path = string_field(input, "path")?;
    let old = string_field(input, "old_str")?;
    let new = string_field(input, "new_str")?;
    validate_path(path)?;
    let sandbox = context.agent().sandbox();
    let content = sandbox.read_text(path).await?;
    let count = occurrences(&content, old);
    if count == 0 {
        return Err(ToolError::msg(format!("old_str did not appear verbatim in {path}.")));
    }
    if count > 1 {
        return Err(ToolError::msg(format!(
            "old_str appears {count} times in {path}; make it unique."
        )));
    }
    sandbox.write_text(path, &content.replacen(old, new, 1)).await?;
    Ok(format!("Edited {path}.").into())
}

#[cfg(test)]
mod tests;
