//! The sandbox-routed `edit` tool: replaces an exact, unique string in a text file.

use std::sync::Arc;

use serde_json::json;

use super::input::InputReader;
use super::paths::validate_absolute_path;
use super::resolve_sandbox;
use crate::sandbox::Sandbox;
use crate::tools::{FunctionTool, ToolError};
use crate::types::{JsonSchema, JsonValue};

/// The description of the `edit` tool shown to the model (`DEFAULT_EDIT_DESCRIPTION`).
pub const DEFAULT_EDIT_DESCRIPTION: &str = "Replace an exact string in a text file. `old_str` must appear in the file exactly once. Files must use absolute paths.";

/// Options for [`make_edit`] (`MakeEditOptions`).
#[derive(Clone, Default, bon::Builder)]
#[builder(on(String, into))]
pub struct MakeEditOptions {
    /// The sandbox holding the files. `None` uses the calling agent's
    /// [`sandbox`](crate::ToolAgent::sandbox).
    pub sandbox: Option<Arc<dyn Sandbox>>,
    /// The tool name; `edit` when absent.
    pub name: Option<String>,
    /// The tool description; [`DEFAULT_EDIT_DESCRIPTION`] when absent.
    pub description: Option<String>,
}

impl std::fmt::Debug for MakeEditOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MakeEditOptions")
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
            "old_str": {"type": "string", "description": "Exact text to find. Must be unique within the file."},
            "new_str": {"type": "string", "description": "Replacement text."}
        },
        "required": ["path", "old_str", "new_str"],
        "additionalProperties": false
    })
}

/// The default `edit` tool, editing through the calling agent's sandbox (`edit`).
#[must_use]
pub fn edit() -> FunctionTool {
    make_edit(MakeEditOptions::default())
}

/// Creates a sandbox-routed edit tool: replaces the one occurrence of `old_str`
/// with `new_str`, inserted literally.
///
/// The call fails when `path` is not absolute or has a `..` segment, when `old_str` is empty,
/// and when it appears in the file zero times or more than once.
///
/// ```
/// use strands::vended_tools::edit::{DEFAULT_EDIT_DESCRIPTION, MakeEditOptions, make_edit};
///
/// let tool = make_edit(MakeEditOptions::default());
/// assert_eq!(strands::Tool::description(&tool), DEFAULT_EDIT_DESCRIPTION);
/// ```
#[must_use]
pub fn make_edit(options: MakeEditOptions) -> FunctionTool {
    let name = options.name.unwrap_or_else(|| "edit".to_owned());
    let description = options
        .description
        .unwrap_or_else(|| DEFAULT_EDIT_DESCRIPTION.to_owned());
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
    let old_str = reader.string("old_str");
    let new_str = reader.string("new_str");
    reader.finish()?;
    let (path, old_str, new_str) = (
        path.unwrap_or_default(),
        old_str.unwrap_or_default(),
        new_str.unwrap_or_default(),
    );
    validate_absolute_path(path)?;
    if old_str.is_empty() {
        return Err(ToolError::msg("old_str must not be empty."));
    }
    let content = sandbox.read_text(path).await?;
    let occurrences = content.matches(old_str).count();
    if occurrences == 0 {
        return Err(ToolError::msg(format!("old_str did not appear verbatim in {path}.")));
    }
    if occurrences > 1 {
        return Err(ToolError::msg(format!(
            "old_str appears {occurrences} times in {path}; make it unique."
        )));
    }
    sandbox.write_text(path, &content.replacen(old_str, new_str, 1)).await?;
    Ok(format!("Edited {path}.").into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::Tool;
    use crate::vended_tools::test_support::{agent, error_text};

    #[tokio::test]
    async fn rejects_a_relative_path() {
        let input = json!({"path": "relative.txt", "old_str": "a", "new_str": "b"});
        assert!(error_text(&edit(), input, &agent()).await.contains("not absolute"));
    }

    #[test]
    fn defaults_to_the_edit_name_and_description() {
        assert_eq!(edit().name(), "edit");
        assert_eq!(edit().description(), DEFAULT_EDIT_DESCRIPTION);
    }

    #[test]
    fn applies_name_and_description_overrides_without_a_sandbox() {
        let custom = make_edit(
            MakeEditOptions::builder()
                .name("my_edit")
                .description("Custom edit.")
                .build(),
        );
        assert_eq!(custom.name(), "my_edit");
        assert_eq!(custom.description(), "Custom edit.");
    }

    #[test]
    fn applies_overrides_when_a_sandbox_is_bound() {
        let custom = make_edit(MakeEditOptions {
            sandbox: Some(Arc::new(crate::sandbox::NotASandboxLocalEnvironment::new())),
            name: Some("sandbox_edit".to_owned()),
            ..MakeEditOptions::default()
        });
        assert_eq!(custom.name(), "sandbox_edit");
        assert_eq!(custom.description(), DEFAULT_EDIT_DESCRIPTION);
    }

    #[cfg(unix)]
    mod host {
        use super::*;
        use crate::sandbox::NotASandboxLocalEnvironment;
        use crate::vended_tools::test_support::{RecordingSandbox, agent_with_sandbox, ok_text};

        fn edit_tool() -> FunctionTool {
            make_edit(MakeEditOptions {
                sandbox: Some(Arc::new(NotASandboxLocalEnvironment::new())),
                ..MakeEditOptions::default()
            })
        }

        fn file(dir: &tempfile::TempDir, content: &str) -> String {
            let path = dir.path().join("f.txt");
            std::fs::write(&path, content).unwrap();
            path.to_string_lossy().into_owned()
        }

        fn contents(path: &str) -> String {
            std::fs::read_to_string(path).unwrap()
        }

        fn input(path: &str, old_str: &str, new_str: &str) -> JsonValue {
            json!({"path": path, "old_str": old_str, "new_str": new_str})
        }

        #[tokio::test]
        async fn replaces_a_unique_match() {
            let dir = tempfile::tempdir().unwrap();
            let path = file(&dir, "alpha\nbeta\ngamma");
            let message = ok_text(&edit_tool(), input(&path, "beta", "BETA"), &agent()).await;
            assert_eq!(message, format!("Edited {path}."));
            assert_eq!(contents(&path), "alpha\nBETA\ngamma");
        }

        #[tokio::test]
        async fn rejects_an_empty_old_str() {
            let dir = tempfile::tempdir().unwrap();
            let path = file(&dir, "alpha");
            let message = error_text(&edit_tool(), input(&path, "", "x"), &agent()).await;
            assert!(message.contains("old_str must not be empty"));
        }

        #[tokio::test]
        async fn rejects_a_missing_match() {
            let dir = tempfile::tempdir().unwrap();
            let path = file(&dir, "alpha\nbeta");
            let message = error_text(&edit_tool(), input(&path, "zeta", "x"), &agent()).await;
            assert!(message.contains("did not appear verbatim"));
        }

        #[tokio::test]
        async fn rejects_an_ambiguous_match_and_leaves_the_file_untouched() {
            let dir = tempfile::tempdir().unwrap();
            let path = file(&dir, "foo\nfoo\nfoo");
            let message = error_text(&edit_tool(), input(&path, "foo", "bar"), &agent()).await;
            assert!(message.contains("appears 3 times"));
            assert_eq!(contents(&path), "foo\nfoo\nfoo");
        }

        #[tokio::test]
        async fn deletes_the_match_when_new_str_is_empty() {
            let dir = tempfile::tempdir().unwrap();
            let path = file(&dir, "keep\nremove-me\nkeep");
            ok_text(&edit_tool(), input(&path, "remove-me\n", ""), &agent()).await;
            assert_eq!(contents(&path), "keep\nkeep");
        }

        #[tokio::test]
        async fn replaces_a_multiline_old_str() {
            let dir = tempfile::tempdir().unwrap();
            let path = file(&dir, "a\nb\nc\nd");
            ok_text(&edit_tool(), input(&path, "b\nc", "B\nC\nC2"), &agent()).await;
            assert_eq!(contents(&path), "a\nB\nC\nC2\nd");
        }

        #[tokio::test]
        async fn inserts_replacement_patterns_in_new_str_literally() {
            let dir = tempfile::tempdir().unwrap();
            let path = file(&dir, "x = 1");
            ok_text(&edit_tool(), input(&path, "1", "$& $1 $$"), &agent()).await;
            assert_eq!(contents(&path), "x = $& $1 $$");
        }

        #[tokio::test]
        async fn uses_the_bound_sandbox_over_the_agent_sandbox() {
            let dir = tempfile::tempdir().unwrap();
            let path = file(&dir, "x");
            let exploding = agent_with_sandbox(Arc::new(RecordingSandbox::default()));
            ok_text(&edit_tool(), input(&path, "x", "y"), &exploding).await;
            assert_eq!(contents(&path), "y");
        }

        #[tokio::test]
        async fn default_edit_reads_the_agent_sandbox() {
            let dir = tempfile::tempdir().unwrap();
            let path = file(&dir, "hello");
            ok_text(&edit(), input(&path, "hello", "world"), &agent()).await;
            assert_eq!(contents(&path), "world");
        }
    }
}
