//! The sandbox-routed `write` tool: creates or overwrites a text file. Pairs with
//! [`read`](super::read) and [`edit`](super::edit).

use std::sync::Arc;

use serde_json::json;

use super::input::InputReader;
use super::paths::validate_absolute_path;
use super::resolve_sandbox;
use crate::sandbox::Sandbox;
use crate::tools::{FunctionTool, ToolError};
use crate::types::{JsonSchema, JsonValue};

/// The description of the `write` tool shown to the model (`DEFAULT_WRITE_DESCRIPTION`).
pub const DEFAULT_WRITE_DESCRIPTION: &str =
    "Create or overwrite a text file with the full provided content. Files must use absolute paths.";

/// Options for [`make_write`] (`MakeWriteOptions`).
#[derive(Clone, Default, bon::Builder)]
#[builder(on(String, into))]
pub struct MakeWriteOptions {
    /// The sandbox to write to. `None` uses the calling agent's
    /// [`sandbox`](crate::ToolAgent::sandbox).
    pub sandbox: Option<Arc<dyn Sandbox>>,
    /// The tool name; `write` when absent.
    pub name: Option<String>,
    /// The tool description; [`DEFAULT_WRITE_DESCRIPTION`] when absent.
    pub description: Option<String>,
}

impl std::fmt::Debug for MakeWriteOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MakeWriteOptions")
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
            "path": {"type": "string", "description": "Absolute path to the file."},
            "content": {"type": "string", "description": "The full file content to write."}
        },
        "required": ["path", "content"],
        "additionalProperties": false
    })
}

/// The default `write` tool, writing through the calling agent's sandbox (`write`).
#[must_use]
pub fn write() -> FunctionTool {
    make_write(MakeWriteOptions::default())
}

/// Creates a sandbox-routed write tool. Missing parent directories are created;
/// the call fails when `path` is not absolute or has a `..` segment.
///
/// ```
/// use strands::vended_tools::write::{MakeWriteOptions, make_write};
///
/// let tool = make_write(MakeWriteOptions::builder().name("save").build());
/// assert_eq!(strands::Tool::name(&tool), "save");
/// ```
#[must_use]
pub fn make_write(options: MakeWriteOptions) -> FunctionTool {
    let name = options.name.unwrap_or_else(|| "write".to_owned());
    let description = options
        .description
        .unwrap_or_else(|| DEFAULT_WRITE_DESCRIPTION.to_owned());
    let bound = options.sandbox;
    FunctionTool::builder(name, description)
        .input_schema(input_schema())
        .callback(move |input, context| {
            let sandbox = resolve_sandbox(bound.as_ref(), &context);
            async move { run(sandbox.as_ref(), &input).await }
        })
}

async fn run(sandbox: &dyn Sandbox, input: &JsonValue) -> Result<JsonValue, ToolError> {
    let mut reader = InputReader::new(input);
    let path = reader.string("path");
    let content = reader.string("content");
    reader.finish()?;
    let (path, content) = (path.unwrap_or_default(), content.unwrap_or_default());
    validate_absolute_path(path)?;
    sandbox.write_text(path, content).await?;
    let line_count = if content.is_empty() {
        0
    } else {
        content.matches('\n').count() + 1
    };
    let noun = if line_count == 1 { "line" } else { "lines" };
    Ok(format!("Wrote {line_count} {noun} to {path}.").into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vended_tools::test_support::{RecordingSandbox, agent, agent_with_sandbox, error_text};

    #[tokio::test]
    async fn rejects_relative_path() {
        let message = error_text(&write(), json!({"path": "relative.txt", "content": "x"}), &agent()).await;
        assert!(message.contains("not absolute"));
    }

    #[tokio::test]
    async fn rejects_parent_traversal_posix() {
        let message = error_text(
            &write(),
            json!({"path": "/tmp/../etc/passwd", "content": "x"}),
            &agent(),
        )
        .await;
        assert!(message.contains("path traversal is not allowed"));
    }

    #[tokio::test]
    async fn rejects_parent_traversal_windows() {
        let input = json!({"path": "C:\\project\\..\\etc\\hosts", "content": "x"});
        let message = error_text(&write(), input, &agent()).await;
        assert!(message.contains("path traversal is not allowed"));
    }

    #[tokio::test]
    async fn default_write_reads_agent_sandbox() {
        let sandbox = Arc::new(RecordingSandbox::default());
        let agent = agent_with_sandbox(sandbox.clone());
        let message = crate::vended_tools::test_support::ok_text(
            &write(),
            json!({"path": "/tmp/f.txt", "content": "from-agent"}),
            &agent,
        )
        .await;
        assert_eq!(message, "Wrote 1 line to /tmp/f.txt.");
        assert_eq!(
            *sandbox.writes.lock().unwrap(),
            [("/tmp/f.txt".to_owned(), b"from-agent".to_vec())]
        );
    }

    #[cfg(unix)]
    mod host {
        use super::*;
        use crate::sandbox::NotASandboxLocalEnvironment;
        use crate::vended_tools::test_support::ok_text;

        fn write_tool() -> FunctionTool {
            make_write(MakeWriteOptions {
                sandbox: Some(Arc::new(NotASandboxLocalEnvironment::new())),
                ..MakeWriteOptions::default()
            })
        }

        async fn write_file(path: &std::path::Path, content: &str) -> String {
            let input = json!({"path": path.to_string_lossy(), "content": content});
            ok_text(&write_tool(), input, &agent()).await
        }

        #[tokio::test]
        async fn creates_file() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("new.txt");
            let message = write_file(&path, "hello\nworld").await;
            assert_eq!(message, format!("Wrote 2 lines to {}.", path.display()));
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello\nworld");
        }

        #[tokio::test]
        async fn overwrites_existing_file() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("f.txt");
            std::fs::write(&path, "old content").unwrap();
            let message = write_file(&path, "new").await;
            assert_eq!(message, format!("Wrote 1 line to {}.", path.display()));
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
        }

        #[tokio::test]
        async fn empty_content_reports_zero_lines() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("empty.txt");
            let message = write_file(&path, "").await;
            assert_eq!(message, format!("Wrote 0 lines to {}.", path.display()));
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "");
        }

        #[tokio::test]
        async fn single_line_without_trailing_newline() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("one.txt");
            let message = write_file(&path, "just one line").await;
            assert_eq!(message, format!("Wrote 1 line to {}.", path.display()));
        }

        #[tokio::test]
        async fn trailing_newline_counts_the_empty_tail() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("tail.txt");
            let message = write_file(&path, "a\nb\n").await;
            assert_eq!(message, format!("Wrote 3 lines to {}.", path.display()));
        }

        #[tokio::test]
        async fn creates_parent_directories() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("a").join("b").join("c.txt");
            write_file(&path, "deep").await;
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "deep");
        }

        #[tokio::test]
        async fn bound_sandbox_overrides_agent_sandbox() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("f.txt");
            let agent_sandbox = Arc::new(RecordingSandbox::default());
            let input = json!({"path": path.to_string_lossy(), "content": "from-bound"});
            ok_text(&write_tool(), input, &agent_with_sandbox(agent_sandbox.clone())).await;
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "from-bound");
            assert!(agent_sandbox.writes.lock().unwrap().is_empty());
        }
    }
}
