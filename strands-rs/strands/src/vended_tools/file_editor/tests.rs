#![cfg(unix)]
//! The main suite runs through the agent's default sandbox (the host), the sandbox suite through
//! [`TestSandbox`].

use std::path::Path;

use async_trait::async_trait;
use serde_json::json;
use tempfile::TempDir;

use super::*;
use crate::agent::ToolAgent;
use crate::sandbox::test_sandbox::TestSandbox;
use crate::sandbox::{ExecuteOptions, ExecutionStream, FileInfo};
use crate::vended_tools::test_support::{agent, agent_with_sandbox, error_text, ok_text};

fn tool() -> FunctionTool {
    file_editor()
}

fn create_file(dir: &TempDir, name: &str, content: &str) -> String {
    let path = dir.path().join(name);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, content).unwrap();
    text_path(&path)
}

fn create_dir(dir: &TempDir, name: &str, files: &[(&str, &str)]) -> String {
    let path = dir.path().join(name);
    std::fs::create_dir_all(&path).unwrap();
    for (file, content) in files {
        let file = path.join(file);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, content).unwrap();
    }
    text_path(&path)
}

fn text_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn contents(path: &str) -> String {
    std::fs::read_to_string(path).unwrap()
}

async fn ok(input: JsonValue) -> String {
    ok_text(&tool(), input, &agent()).await
}

async fn err(input: JsonValue) -> String {
    error_text(&tool(), input, &agent()).await
}

#[tokio::test]
async fn returns_file_content_with_line_numbers() {
    let dir = tempfile::tempdir().unwrap();
    let path = create_file(&dir, "test.txt", "Line 1\nLine 2\nLine 3");
    let result = ok(json!({"command": "view", "path": path})).await;
    assert_eq!(
        result,
        format!("Here's the result of running `cat -n` on {path}:\n     1  Line 1\n     2  Line 2\n     3  Line 3\n")
    );
}

#[tokio::test]
async fn handles_empty_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = create_file(&dir, "empty.txt", "");
    assert!(
        ok(json!({"command": "view", "path": path}))
            .await
            .contains("Here's the result of running `cat -n`")
    );
}

#[tokio::test]
async fn handles_single_line_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = create_file(&dir, "single.txt", "Only one line");
    assert!(
        ok(json!({"command": "view", "path": path}))
            .await
            .contains("     1  Only one line")
    );
}

#[tokio::test]
async fn returns_specified_lines_with_line_numbers() {
    let dir = tempfile::tempdir().unwrap();
    let path = create_file(&dir, "test.txt", "Line 1\nLine 2\nLine 3\nLine 4\nLine 5");
    let result = ok(json!({"command": "view", "path": path, "view_range": [2, 4]})).await;
    assert!(result.contains("     2  Line 2") && result.contains("     4  Line 4"));
    assert!(!result.contains("     1  ") && !result.contains("     5  "));
}

#[tokio::test]
async fn handles_negative_end_index_minus_1_means_to_end() {
    let dir = tempfile::tempdir().unwrap();
    let path = create_file(&dir, "test.txt", "Line 1\nLine 2\nLine 3\nLine 4\nLine 5");
    let result = ok(json!({"command": "view", "path": path, "view_range": [3, -1]})).await;
    assert!(result.contains("     3  Line 3") && result.contains("     5  Line 5"));
    assert!(!result.contains("     1  ") && !result.contains("     2  "));
}

#[tokio::test]
async fn handles_single_line_range() {
    let dir = tempfile::tempdir().unwrap();
    let path = create_file(&dir, "test.txt", "Line 1\nLine 2\nLine 3");
    let result = ok(json!({"command": "view", "path": path, "view_range": [2, 2]})).await;
    assert!(result.contains("     2  Line 2"));
    assert!(!result.contains("     1  ") && !result.contains("     3  "));
}

#[tokio::test]
async fn lists_files_up_to_2_levels_deep() {
    let dir = tempfile::tempdir().unwrap();
    let files = [
        ("file1.txt", "content"),
        ("file2.txt", "content"),
        ("subdir/file3.txt", "content"),
        ("subdir/nested/file4.txt", "content"),
    ];
    let path = create_dir(&dir, "testdir", &files);
    assert_eq!(
        ok(json!({"command": "view", "path": path})).await,
        format!(
            "Here's the files and directories up to 2 levels deep in {path}, excluding hidden items:\nfile1.txt\nfile2.txt\nsubdir\nsubdir/file3.txt\nsubdir/nested\nsubdir/nested/file4.txt\n"
        )
    );
}

#[tokio::test]
async fn excludes_hidden_files() {
    let dir = tempfile::tempdir().unwrap();
    let files = [
        ("visible.txt", "content"),
        (".hidden.txt", "content"),
        ("subdir/.hidden-dir/file.txt", "content"),
    ];
    let path = create_dir(&dir, "testdir", &files);
    let result = ok(json!({"command": "view", "path": path})).await;
    assert!(result.contains("visible.txt"));
    assert!(!result.contains(".hidden"));
}

#[tokio::test]
async fn throws_when_file_not_found() {
    let dir = tempfile::tempdir().unwrap();
    let path = text_path(&dir.path().join("nonexistent.txt"));
    assert!(
        err(json!({"command": "view", "path": path}))
            .await
            .contains("does not exist")
    );
}

#[tokio::test]
async fn throws_when_path_is_not_absolute() {
    let message = err(json!({"command": "view", "path": "relative/path.txt"})).await;
    assert!(message.starts_with(
        "The path relative/path.txt is not an absolute path, it should start with `/`. Maybe you meant /"
    ));
    let message = err(json!({"command": "create", "path": "relative/path.txt", "file_text": "x"})).await;
    assert!(message.contains("not an absolute path"));
}

#[tokio::test]
async fn throws_on_path_traversal_with_absolute_path() {
    assert!(
        err(json!({"command": "view", "path": "/tmp/../etc/passwd"}))
            .await
            .contains("path traversal")
    );
}

#[tokio::test]
async fn throws_when_view_range_is_invalid() {
    let dir = tempfile::tempdir().unwrap();
    let path = create_file(&dir, "test.txt", "Line 1\nLine 2\nLine 3");
    let cases = [
        (
            json!([0, 2]),
            "Invalid `view_range`: [0, 2]. Its first element `0` should be within the range of lines of the file: [1, 3]",
        ),
        (
            json!([1, 10]),
            "Invalid `view_range`: [1, 10]. Its second element `10` should be smaller than the number of lines in the file: `3`",
        ),
        (
            json!([3, 1]),
            "Invalid `view_range`: [3, 1]. Its second element `1` should be larger or equal than its first `3`",
        ),
    ];
    for (range, message) in cases {
        assert_eq!(
            err(json!({"command": "view", "path": path, "view_range": range})).await,
            message
        );
    }
}

#[tokio::test]
async fn throws_when_view_range_is_provided_for_directory() {
    let dir = tempfile::tempdir().unwrap();
    let path = create_dir(&dir, "testdir", &[("file.txt", "content")]);
    let message = err(json!({"command": "view", "path": path, "view_range": [1, 2]})).await;
    assert!(message.contains("not allowed when"));
}

#[tokio::test]
async fn creates_new_file_with_content() {
    let dir = tempfile::tempdir().unwrap();
    let path = text_path(&dir.path().join("new-file.txt"));
    let result = ok(json!({"command": "create", "path": path, "file_text": "Hello World\nLine 2"})).await;
    assert_eq!(result, format!("File created successfully at: {path}"));
    assert_eq!(contents(&path), "Hello World\nLine 2");
}

#[tokio::test]
async fn creates_file_in_non_existent_directory() {
    let dir = tempfile::tempdir().unwrap();
    let path = text_path(&dir.path().join("newdir/subdir/new-file.txt"));
    ok(json!({"command": "create", "path": path, "file_text": "Content"})).await;
    assert_eq!(contents(&path), "Content");
}

#[tokio::test]
async fn creates_empty_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = text_path(&dir.path().join("empty.txt"));
    ok(json!({"command": "create", "path": path, "file_text": ""})).await;
    assert_eq!(contents(&path), "");
}

#[tokio::test]
async fn throws_when_file_already_exists() {
    let dir = tempfile::tempdir().unwrap();
    let path = create_file(&dir, "existing.txt", "content");
    let message = err(json!({"command": "create", "path": path, "file_text": "new content"})).await;
    assert!(message.contains("already exists"));
    let dir_path = create_dir(&dir, "testdir", &[]);
    let message = err(json!({"command": "create", "path": dir_path, "file_text": "content"})).await;
    assert!(message.contains("already exists"));
}

#[tokio::test]
async fn throws_when_path_contains_traversal() {
    err(json!({"command": "create", "path": "..outside.txt", "file_text": "content"})).await;
}

#[tokio::test]
async fn throws_when_a_command_parameter_is_missing() {
    assert_eq!(
        err(json!({"command": "create", "path": "/tmp/x"})).await,
        "Parameter `file_text` is required for command: create"
    );
    assert_eq!(
        err(json!({"command": "str_replace", "path": "/tmp/x"})).await,
        "Parameter `old_str` is required for command: str_replace"
    );
    assert_eq!(
        err(json!({"command": "insert", "path": "/tmp/x", "new_str": "x"})).await,
        "Parameters `insert_line` and `new_str` are required for command: insert"
    );
}

#[tokio::test]
async fn replaces_unique_string_occurrence() {
    let dir = tempfile::tempdir().unwrap();
    let path = create_file(&dir, "test.txt", "Line 1\nLine 2 OLD\nLine 3\nLine 4");
    let result = ok(json!({"command": "str_replace", "path": path, "old_str": "OLD", "new_str": "NEW"})).await;
    assert_eq!(
        result,
        format!(
            "The file {path} has been edited. Here's the result of running `cat -n` on a snippet of {path}:\n     1  Line 1\n     2  Line 2 NEW\n     3  Line 3\n     4  Line 4\nReview the changes and make sure they are as expected. Edit the file again if necessary."
        )
    );
    assert_eq!(contents(&path), "Line 1\nLine 2 NEW\nLine 3\nLine 4");
}

#[tokio::test]
async fn shows_snippet_with_4_lines_before_and_after_change() {
    let dir = tempfile::tempdir().unwrap();
    let content = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5 OLD\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10";
    let path = create_file(&dir, "test.txt", content);
    let result = ok(json!({"command": "str_replace", "path": path, "old_str": "OLD", "new_str": "NEW"})).await;
    assert!(result.contains("Line 1") && result.contains("Line 9"));
    assert!(!result.contains("Line 10"));
}

#[tokio::test]
async fn replaces_and_preserves_content() {
    let cases = [
        (
            "Line 1\nLine 2 DELETE_ME\nLine 3",
            " DELETE_ME",
            Some(""),
            "Line 1\nLine 2\nLine 3",
        ),
        (
            "Line 1\nOLD LINE 1\nOLD LINE 2\nLine 4",
            "OLD LINE 1\nOLD LINE 2",
            Some("NEW LINE"),
            "Line 1\nNEW LINE\nLine 4",
        ),
        (
            "const value = getPrice()",
            "getPrice()",
            Some("$& is not $1 or $$"),
            "const value = $& is not $1 or $$",
        ),
        (
            "func a() {\n\treturn 1\n}\r\n\r\nfunc b() {\n\treturn 2\n}\n",
            "\treturn 1",
            Some("\treturn 10"),
            "func a() {\n\treturn 10\n}\r\n\r\nfunc b() {\n\treturn 2\n}\n",
        ),
        (
            "\t\t\tfirst\n\t\t\tsecond\n\t\t\tthird\n",
            "\t\t\tsecond",
            Some("\t\t\treplaced"),
            "\t\t\tfirst\n\t\t\treplaced\n\t\t\tthird\n",
        ),
        (
            "line1\r\nline2\r\nline3\r\n",
            "line2",
            Some("changed"),
            "line1\r\nchanged\r\nline3\r\n",
        ),
        (
            "function hello() {\n  console.log(\"hi\")\n  return true\n}\n",
            "  console.log(\"hi\")\n  return true",
            Some("  return false"),
            "function hello() {\n  return false\n}\n",
        ),
        ("keep\ndelete me\nkeep too\n", "delete me\n", None, "keep\nkeep too\n"),
        (
            "price is $100.00 (USD)\nother line\n",
            "$100.00 (USD)",
            Some("$200.00 (EUR)"),
            "price is $200.00 (EUR)\nother line\n",
        ),
        (
            "normal\n\x00\x01\x02\n\ttabbed\nnormal again\n",
            "normal again",
            Some("done"),
            "normal\n\x00\x01\x02\n\ttabbed\ndone\n",
        ),
        (
            "first line\nsecond\n",
            "first line",
            Some("new first"),
            "new first\nsecond\n",
        ),
        ("first\nlast line", "last line", Some("new last"), "first\nnew last"),
        (
            "x\n",
            "x",
            Some("a very long replacement string that is much bigger"),
            "a very long replacement string that is much bigger\n",
        ),
        (
            "\tindented with tab\n    indented with spaces\n  \tmixed\n",
            "    indented with spaces",
            Some("    changed"),
            "\tindented with tab\n    changed\n  \tmixed\n",
        ),
    ];
    for (content, old_str, new_str, expected) in cases {
        let dir = tempfile::tempdir().unwrap();
        let path = create_file(&dir, "f.txt", content);
        let mut input = json!({"command": "str_replace", "path": path, "old_str": old_str});
        if let Some(new_str) = new_str {
            input["new_str"] = json!(new_str);
        }
        assert!(ok(input).await.contains("has been edited"));
        assert_eq!(contents(&path), expected, "{old_str:?}");
    }
}

#[tokio::test]
async fn str_replace_error_cases() {
    let dir = tempfile::tempdir().unwrap();
    let path = create_file(&dir, "test.txt", "Line 1\nLine 2\nLine 3");
    let replace = |path: &str, old_str: &str| json!({"command": "str_replace", "path": path, "old_str": old_str, "new_str": "NEW"});
    assert!(err(replace(&path, "NOTFOUND")).await.contains("did not appear"));
    assert!(err(replace(&path, "")).await.contains("must not be empty"));
    let dup = create_file(&dir, "dup.txt", "DUP Line 1\nLine 2\nDUP Line 3");
    assert!(err(replace(&dup, "DUP")).await.contains("Multiple occurrences"));
    let missing = text_path(&dir.path().join("nonexistent.txt"));
    assert!(err(replace(&missing, "OLD")).await.contains("does not exist"));
    let directory = create_dir(&dir, "testdir", &[]);
    assert!(err(replace(&directory, "OLD")).await.contains("directory"));
}

#[tokio::test]
async fn reports_correct_line_numbers_for_repeated_multi_line_old_str() {
    let dir = tempfile::tempdir().unwrap();
    let path = create_file(&dir, "multi.txt", "if (x) {\n  do()\n}\nspacer\nif (x) {\n  do()\n}\n");
    let message =
        err(json!({"command": "str_replace", "path": path, "old_str": "if (x) {\n  do()\n}", "new_str": "z"})).await;
    assert!(message.contains("lines [1,5]"), "{message}");
}

async fn insert_into(content: &str, insert_line: i64, new_str: &str) -> (String, String) {
    let dir = tempfile::tempdir().unwrap();
    let path = create_file(&dir, "test.txt", content);
    let result = ok(json!({"command": "insert", "path": path, "insert_line": insert_line, "new_str": new_str})).await;
    (result, contents(&path))
}

#[tokio::test]
async fn inserts_lines() {
    let cases = [
        (
            "Line 1\nLine 2\nLine 3",
            0,
            "NEW LINE",
            "NEW LINE\nLine 1\nLine 2\nLine 3",
        ),
        (
            "Line 1\nLine 2\nLine 3",
            2,
            "NEW LINE",
            "Line 1\nLine 2\nNEW LINE\nLine 3",
        ),
        (
            "Line 1\nLine 2\nLine 3",
            3,
            "NEW LINE",
            "Line 1\nLine 2\nLine 3\nNEW LINE",
        ),
        (
            "Line 1\nLine 2",
            1,
            "NEW 1\nNEW 2\nNEW 3",
            "Line 1\nNEW 1\nNEW 2\nNEW 3\nLine 2",
        ),
        ("", 0, "First line", "First line"),
    ];
    for (content, insert_line, new_str, expected) in cases {
        let (result, updated) = insert_into(content, insert_line, new_str).await;
        assert!(result.contains("has been edited"));
        assert_eq!(updated, expected);
    }
}

#[tokio::test]
async fn shows_snippet_with_4_lines_before_and_after_insertion() {
    let content = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9";
    let (result, _) = insert_into(content, 5, "INSERTED").await;
    assert!(result.contains("Line 2") && result.contains("Line 9") && result.contains("INSERTED"));
    assert!(result.ends_with("Review the changes and make sure they are as expected (correct indentation, no duplicate lines, etc). Edit the file again if necessary."));
}

#[tokio::test]
async fn insert_error_cases() {
    let dir = tempfile::tempdir().unwrap();
    let path = create_file(&dir, "test.txt", "Line 1\nLine 2");
    let insert =
        |path: &str, line: i64| json!({"command": "insert", "path": path, "insert_line": line, "new_str": "NEW"});
    assert_eq!(
        err(insert(&path, -1)).await,
        "Invalid `insert_line` parameter: -1. It should be within the range of lines of the file: [0, 2]"
    );
    assert!(err(insert(&path, 10)).await.contains("insert_line"));
    let missing = text_path(&dir.path().join("nonexistent.txt"));
    assert!(err(insert(&missing, 0)).await.contains("does not exist"));
    let directory = create_dir(&dir, "testdir", &[]);
    assert!(err(insert(&directory, 0)).await.contains("directory"));
}

#[tokio::test]
async fn throws_when_file_exceeds_default_size_limit() {
    let dir = tempfile::tempdir().unwrap();
    let path = create_file(&dir, "large.txt", &"x".repeat(1_048_577));
    assert_eq!(
        err(json!({"command": "view", "path": path})).await,
        "File size (1048577 bytes) exceeds maximum allowed size (1048576 bytes)"
    );
}

#[tokio::test]
async fn handles_special_and_unicode_characters_and_expands_tabs() {
    let dir = tempfile::tempdir().unwrap();
    let special = create_file(&dir, "special.txt", "Special chars: @#$%^&*()_+-={}[]|:;\"<>,.?/~`");
    assert!(
        ok(json!({"command": "view", "path": special}))
            .await
            .contains("Special chars:")
    );
    let unicode = create_file(&dir, "unicode.txt", "你好世界\n🚀 Emoji test\nΣ Greek letters");
    let result = ok(json!({"command": "view", "path": unicode})).await;
    assert!(result.contains("你好世界") && result.contains('🚀'));
    let tabs = create_file(&dir, "tabs.txt", "Line 1\tTab\tSeparated");
    assert!(!ok(json!({"command": "view", "path": tabs})).await.contains('\t'));
}

fn sandbox_agent(dir: &TempDir) -> ToolAgent {
    agent_with_sandbox(Arc::new(TestSandbox::new(dir.path().to_string_lossy())))
}

#[tokio::test]
async fn works_through_the_sandbox() {
    let dir = tempfile::tempdir().unwrap();
    let agent = sandbox_agent(&dir);
    let hello = create_file(&dir, "hello.txt", "line 1\nline 2\n");
    let result = ok_text(&tool(), json!({"command": "view", "path": hello}), &agent).await;
    assert!(result.contains("line 1") && result.contains("line 2"));

    let created = text_path(&dir.path().join("new.txt"));
    ok_text(
        &tool(),
        json!({"command": "create", "path": created, "file_text": "created"}),
        &agent,
    )
    .await;
    assert_eq!(contents(&created), "created");

    let edited = create_file(&dir, "edit.txt", "hello world");
    let input = json!({"command": "str_replace", "path": edited, "old_str": "world", "new_str": "sandbox"});
    ok_text(&tool(), input, &agent).await;
    assert_eq!(contents(&edited), "hello sandbox");

    let inserted = create_file(&dir, "insert.txt", "line 1\nline 3\n");
    let input = json!({"command": "insert", "path": inserted, "insert_line": 1, "new_str": "line 2"});
    ok_text(&tool(), input, &agent).await;
    assert_eq!(contents(&inserted), "line 1\nline 2\nline 3\n");
}

#[tokio::test]
async fn reports_non_existent_path() {
    let dir = tempfile::tempdir().unwrap();
    let path = text_path(&dir.path().join("nope.txt"));
    let message = error_text(&tool(), json!({"command": "view", "path": path}), &sandbox_agent(&dir)).await;
    assert!(message.contains("does not exist"));
}

struct DeniedListing(TestSandbox);

#[async_trait]
impl Sandbox for DeniedListing {
    fn execute_streaming(&self, command: &str, options: ExecuteOptions) -> ExecutionStream {
        Sandbox::execute_streaming(&self.0, command, options)
    }

    fn execute_code_streaming(&self, code: &str, language: &str, options: ExecuteOptions) -> ExecutionStream {
        Sandbox::execute_code_streaming(&self.0, code, language, options)
    }

    async fn read_file(&self, path: &str) -> crate::Result<Vec<u8>> {
        Sandbox::read_file(&self.0, path).await
    }

    async fn write_file(&self, path: &str, content: &[u8]) -> crate::Result<()> {
        Sandbox::write_file(&self.0, path, content).await
    }

    async fn remove_file(&self, path: &str) -> crate::Result<()> {
        Sandbox::remove_file(&self.0, path).await
    }

    async fn list_files(&self, _path: &str) -> crate::Result<Vec<FileInfo>> {
        Err(Error::other("EACCES: permission denied"))
    }
}

#[tokio::test]
async fn propagates_non_not_found_list_files_errors_instead_of_reporting_non_existence() {
    let dir = tempfile::tempdir().unwrap();
    let agent = agent_with_sandbox(Arc::new(DeniedListing(TestSandbox::new(dir.path().to_string_lossy()))));
    let path = text_path(&dir.path().join("x.txt"));
    let message = error_text(&tool(), json!({"command": "view", "path": path}), &agent).await;
    assert!(message.contains("permission denied"));
}

#[tokio::test]
async fn detects_directory_via_sandbox_list_files() {
    let dir = tempfile::tempdir().unwrap();
    let path = create_dir(&dir, "subdir", &[("a.txt", "a")]);
    let result = ok_text(&tool(), json!({"command": "view", "path": path}), &sandbox_agent(&dir)).await;
    assert!(result.contains("a.txt"));
}

#[tokio::test]
async fn handles_trailing_slash_on_file_path() {
    let dir = tempfile::tempdir().unwrap();
    let path = create_file(&dir, "trailing.txt", "content here");
    let input = json!({"command": "view", "path": format!("{path}/")});
    assert!(
        ok_text(&tool(), input, &sandbox_agent(&dir))
            .await
            .contains("content here")
    );
}
