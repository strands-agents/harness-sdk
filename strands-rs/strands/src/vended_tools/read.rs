//! The sandbox-routed `read` tool.
//!
//! Text files come back as `cat -n` style numbered lines so the model can cite `path:line`;
//! images (png/jpg/jpeg/gif/webp) and binary documents (pdf/doc/docx/xls/xlsx) come back as
//! media content when `media` is on.

use std::sync::Arc;

use serde_json::json;

use super::input::InputReader;
use super::paths::validate_absolute_path;
use super::resolve_sandbox;
use crate::sandbox::Sandbox;
use crate::tools::{FunctionTool, ToolError};
use crate::types::{
    DocumentBlock, DocumentFormat, DocumentSource, ImageBlock, ImageFormat, ImageSource, JsonSchema, JsonValue,
    ToolResultContent,
};

const READ_DEFAULT_LIMIT: u64 = 2000;
const READ_MAX_BYTES: usize = 1_048_576;
const READ_MAX_MEDIA_BYTES: usize = 10_485_760;

const IMAGE_EXTENSIONS: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];

const PNG: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG: &[u8] = &[0xff, 0xd8, 0xff];
const GIF87A: &[u8] = b"GIF87a";
const GIF89A: &[u8] = b"GIF89a";
const OLE2: &[u8] = &[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP: &[u8] = &[0x50, 0x4b, 0x03, 0x04];
const PDF: &[u8] = b"%PDF-";

/// The description of the `read` tool without the media sentence (`DEFAULT_READ_DESCRIPTION`).
pub const DEFAULT_READ_DESCRIPTION: &str = "Read a file. Text returns `cat -n` style numbered lines so you can cite `path:line`. Files must use absolute paths.";

const MEDIA_DESCRIPTION_SUFFIX: &str =
    " Images (png/jpg/jpeg/gif/webp) and binary documents (pdf/doc/docx/xls/xlsx) return media you can view directly.";

/// Options for [`make_read`] (`MakeReadOptions`).
#[derive(Clone, Default, bon::Builder)]
#[builder(on(String, into))]
pub struct MakeReadOptions {
    /// The sandbox to read from. `None` uses the calling agent's
    /// [`sandbox`](crate::ToolAgent::sandbox).
    pub sandbox: Option<Arc<dyn Sandbox>>,
    /// Return images and binary documents as media; `false` describes them in text instead, for
    /// a model that rejects media blocks. `true` when absent.
    pub media: Option<bool>,
    /// The tool name; `read` when absent.
    pub name: Option<String>,
    /// The tool description; [`DEFAULT_READ_DESCRIPTION`], plus a sentence about media when
    /// `media` is on, when absent.
    pub description: Option<String>,
    /// The largest text window returned, in bytes; 1 MiB when absent.
    pub max_bytes: Option<usize>,
    /// The largest image or document read, in bytes; 10 MiB when absent.
    pub max_media_bytes: Option<usize>,
}

impl std::fmt::Debug for MakeReadOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MakeReadOptions")
            .field("sandbox", &self.sandbox.is_some())
            .field("media", &self.media)
            .field("name", &self.name)
            .field("max_bytes", &self.max_bytes)
            .field("max_media_bytes", &self.max_media_bytes)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy)]
struct Limits {
    media: bool,
    max_bytes: usize,
    max_media_bytes: usize,
}

fn input_schema() -> JsonSchema {
    json!({
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Absolute path to the file."},
            "offset": {
                "description": "1-indexed line to start from. Defaults to the first line. Text files only.",
                "type": "integer",
                "minimum": 1,
                "maximum": 9_007_199_254_740_991_u64
            },
            "limit": {
                "description": "Maximum number of lines to return. Defaults to 2000. Text files only.",
                "type": "integer",
                "minimum": 1,
                "maximum": 9_007_199_254_740_991_u64
            }
        },
        "required": ["path"],
        "additionalProperties": false
    })
}

/// The default `read` tool, reading through the calling agent's sandbox (`read`).
#[must_use]
pub fn read() -> FunctionTool {
    make_read(MakeReadOptions::default())
}

/// Creates a sandbox-routed read tool.
///
/// The call fails when `path` is not absolute or has a `..` segment, when an image or document
/// does not have the bytes its extension promises, when it exceeds a size cap, and when a text
/// file is not UTF-8.
///
/// ```
/// use strands::vended_tools::read::{MakeReadOptions, make_read};
///
/// let read = make_read(MakeReadOptions::builder().media(false).build());
/// assert!(!strands::Tool::description(&read).contains("Images"));
/// ```
#[must_use]
pub fn make_read(options: MakeReadOptions) -> FunctionTool {
    let limits = Limits {
        media: options.media.unwrap_or(true),
        max_bytes: options.max_bytes.unwrap_or(READ_MAX_BYTES),
        max_media_bytes: options.max_media_bytes.unwrap_or(READ_MAX_MEDIA_BYTES),
    };
    let description = options.description.unwrap_or_else(|| {
        let suffix = if limits.media { MEDIA_DESCRIPTION_SUFFIX } else { "" };
        format!("{DEFAULT_READ_DESCRIPTION}{suffix}")
    });
    let name = options.name.unwrap_or_else(|| "read".to_owned());
    let bound = options.sandbox;
    FunctionTool::builder(name, description)
        .input_schema(input_schema())
        .callback(move |input, context| {
            let sandbox = resolve_sandbox(bound.as_ref(), &context);
            async move { run(sandbox.as_ref(), &input, limits).await }
        })
}

async fn run(sandbox: &dyn Sandbox, input: &JsonValue, limits: Limits) -> Result<JsonValue, ToolError> {
    let mut reader = InputReader::new(input);
    let path = reader.string("path");
    let offset = reader.optional_positive_integer("offset", "offset must be a positive 1-indexed line number");
    let limit = reader.optional_positive_integer("limit", "limit must be a positive line count");
    reader.finish()?;
    let path = path.unwrap_or_default();
    validate_absolute_path(path)?;
    let ext = extension(path);

    if IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        let bytes = sandbox.read_file(path).await?;
        let Some(format) = sniff_image_format(&bytes) else {
            return Err(ToolError::msg(format!(
                "{path} has a .{ext} extension but its {} bytes are not a png, jpeg, gif, or webp image. If a shell tool is available, use it to identify or extract text.",
                bytes.len()
            )));
        };
        if !limits.media {
            return Ok(media_placeholder(path, "Image", image_format_name(format), bytes.len()).into());
        }
        check_media_size(path, "image", bytes.len(), limits.max_media_bytes)?;
        let block = ImageBlock::new(format, ImageSource::Bytes(bytes));
        return Ok(serde_json::to_value(ToolResultContent::Image(block))?);
    }

    if let Some((format, signatures)) = document_format(&ext) {
        let bytes = sandbox.read_file(path).await?;
        if !signatures.iter().any(|signature| bytes.starts_with(signature)) {
            return Err(ToolError::msg(format!(
                "{path} has a .{ext} extension but its {} bytes are not a valid {ext} document. If a shell tool is available, use it to identify or extract text.",
                bytes.len()
            )));
        }
        if !limits.media {
            return Ok(media_placeholder(path, "Document", &ext, bytes.len()).into());
        }
        check_media_size(path, "document", bytes.len(), limits.max_media_bytes)?;
        let block = DocumentBlock::new(document_name(path), format, DocumentSource::Bytes(bytes));
        return Ok(serde_json::to_value(ToolResultContent::Document(block))?);
    }

    let bytes = sandbox.read_file(path).await?;
    let Ok(content) = String::from_utf8(bytes) else {
        return Err(ToolError::msg(format!(
            "{path} is not UTF-8 text. If a shell tool is available, inspect it there."
        )));
    };
    Ok(numbered_window(path, &content, offset, limit, limits.max_bytes)?.into())
}

fn numbered_window(
    path: &str,
    content: &str,
    offset: Option<u64>,
    limit: Option<u64>,
    max_bytes: usize,
) -> Result<String, ToolError> {
    let lines: Vec<&str> = content.split('\n').collect();
    let start = offset.map_or(0, |offset| usize::try_from(offset - 1).unwrap_or(usize::MAX));
    let count = usize::try_from(limit.unwrap_or(READ_DEFAULT_LIMIT)).unwrap_or(usize::MAX);
    let end = start.saturating_add(count).min(lines.len());
    let window = lines.get(start..end).unwrap_or_default();
    if window.is_empty() {
        return Ok(format!(
            "[File has {} lines; offset {} is past the end.]",
            lines.len(),
            offset.unwrap_or_default()
        ));
    }
    let window_bytes = window.iter().map(|line| line.len()).sum::<usize>() + window.len() - 1;
    if window_bytes > max_bytes {
        return Err(ToolError::msg(format!(
            "Read window from {path} is {window_bytes} bytes ({} lines), exceeding the {max_bytes}-byte limit. Reduce `limit` or shift `offset` to read a smaller slice.",
            window.len()
        )));
    }
    let mut numbered = window
        .iter()
        .enumerate()
        .map(|(index, line)| format!("{:>6}\t{line}", index + start + 1))
        .collect::<Vec<_>>()
        .join("\n");
    if start > 0 || start.saturating_add(count) < lines.len() {
        numbered.push_str(&format!(
            "\n[Showing lines {}-{} of {}. Use offset/limit to read more.]",
            start + 1,
            start + window.len(),
            lines.len()
        ));
    }
    Ok(numbered)
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
    if data.starts_with(PNG) {
        return Some(ImageFormat::Png);
    }
    if data.starts_with(JPEG) {
        return Some(ImageFormat::Jpeg);
    }
    if data.starts_with(GIF87A) || data.starts_with(GIF89A) {
        return Some(ImageFormat::Gif);
    }
    None
}

fn image_format_name(format: ImageFormat) -> &'static str {
    match format {
        ImageFormat::Png => "png",
        ImageFormat::Gif => "gif",
        ImageFormat::Webp => "webp",
        _ => "jpeg",
    }
}

fn document_format(ext: &str) -> Option<(DocumentFormat, &'static [&'static [u8]])> {
    match ext {
        "pdf" => Some((DocumentFormat::Pdf, &[PDF])),
        "doc" => Some((DocumentFormat::Doc, &[OLE2])),
        "xls" => Some((DocumentFormat::Xls, &[OLE2])),
        "docx" => Some((DocumentFormat::Docx, &[ZIP])),
        "xlsx" => Some((DocumentFormat::Xlsx, &[ZIP])),
        _ => None,
    }
}

fn check_media_size(path: &str, kind: &str, size: usize, max_bytes: usize) -> Result<(), ToolError> {
    if size <= max_bytes {
        return Ok(());
    }
    Err(ToolError::msg(format!(
        "{path} is {size} bytes, exceeding the {max_bytes}-byte limit for {kind} reads. If a shell tool is available, use it to extract a smaller representation."
    )))
}

fn media_placeholder(path: &str, kind: &str, format: &str, size: usize) -> String {
    format!(
        "[{kind} file: {path} ({format}, {size} bytes). This model cannot view {} files, so its contents are not shown. If a shell tool is available, use it when the file has a text-extractable form.]",
        kind.to_lowercase()
    )
}

#[cfg(test)]
mod tests;
