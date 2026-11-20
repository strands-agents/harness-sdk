//! The file tools and the harness `shell`.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{Value, json};
use strands::agent::DirectToolCallOptions;
use strands::sandbox::{ExecuteOptions, ExecutionStream, FileInfo, Sandbox};
use strands::testing::MockModel;
use strands::types::{
    DocumentFormat, DocumentSource, ImageFormat, ImageSource, ToolResultBlock, ToolResultContent, ToolResultStatus,
};
use strands::{Agent, Tool};
use tempfile::TempDir;

use super::*;

fn agent_with(tools: Vec<FunctionTool>) -> Agent {
    Agent::builder()
        .model(MockModel::new())
        .tools(tools)
        .printer(false)
        .build()
        .unwrap()
}

fn agent() -> Agent {
    agent_with(vec![read_tool(true), write_tool(), edit_tool(), read_media_off()])
}

fn read_media_off() -> FunctionTool {
    FunctionTool::builder("read_media_off", READ_DESCRIPTION)
        .input_schema(read_schema())
        .callback(|input, context| async move { read(&input, &context, false).await })
}

async fn call(agent: &mut Agent, name: &str, input: Value) -> ToolResultBlock {
    agent
        .tool(name)
        .invoke_with(
            input,
            DirectToolCallOptions {
                record_direct_tool_call: Some(false),
            },
        )
        .await
        .unwrap()
}

fn text(result: &ToolResultBlock) -> String {
    match result.content.as_slice() {
        [ToolResultContent::Text(text)] => text.text.clone(),
        other => panic!("expected one text block, got {other:?}"),
    }
}

async fn ok_text(agent: &mut Agent, name: &str, input: Value) -> String {
    let result = call(agent, name, input).await;
    assert_eq!(result.status, ToolResultStatus::Success, "{result:?}");
    text(&result)
}

async fn err_text(agent: &mut Agent, name: &str, input: Value) -> String {
    let result = call(agent, name, input).await;
    assert_eq!(result.status, ToolResultStatus::Error, "{result:?}");
    text(&result)
}

fn path(dir: &TempDir, name: &str) -> String {
    dir.path().join(name).to_string_lossy().into_owned()
}

fn image(result: &ToolResultBlock) -> (ImageFormat, Vec<u8>) {
    match result.content.as_slice() {
        [ToolResultContent::Image(image)] => match &image.source {
            ImageSource::Bytes(bytes) => (image.format, bytes.clone()),
            other => panic!("expected bytes, got {other:?}"),
        },
        other => panic!("expected one image block, got {other:?}"),
    }
}

#[tokio::test]
async fn writes_then_reads_with_numbered_lines() {
    let dir = TempDir::new().unwrap();
    let mut agent = agent();
    let file = path(&dir, "f.txt");
    ok_text(&mut agent, "write", json!({"path": file, "content": "alpha\nbeta\n"})).await;
    let out = ok_text(&mut agent, "read", json!({"path": file})).await;
    assert!(out.contains("     1\talpha"));
    assert!(out.contains("     2\tbeta"));
}

#[tokio::test]
async fn pages_with_offset_and_limit() {
    let dir = TempDir::new().unwrap();
    let mut agent = agent();
    let file = path(&dir, "f.txt");
    let content: Vec<String> = (1..=10).map(|i| format!("line{i}")).collect();
    ok_text(
        &mut agent,
        "write",
        json!({"path": file, "content": content.join("\n")}),
    )
    .await;
    let out = ok_text(&mut agent, "read", json!({"path": file, "offset": 3, "limit": 2})).await;
    assert!(out.contains("     3\tline3"));
    assert!(out.contains("     4\tline4"));
    assert!(!out.contains("line5"));
    assert!(out.contains("Showing lines 3-4 of 10"));
}

#[tokio::test]
async fn edits_a_unique_occurrence() {
    let dir = TempDir::new().unwrap();
    let mut agent = agent();
    let file = path(&dir, "f.txt");
    ok_text(
        &mut agent,
        "write",
        json!({"path": file, "content": "one\ntwo\nthree\n"}),
    )
    .await;
    assert_eq!(
        ok_text(
            &mut agent,
            "edit",
            json!({"path": file, "old_str": "two", "new_str": "TWO"})
        )
        .await,
        format!("Edited {file}.")
    );
    let out = ok_text(&mut agent, "read", json!({"path": file})).await;
    assert!(out.contains("     2\tTWO"));
}

#[tokio::test]
async fn rejects_an_edit_whose_old_str_is_missing() {
    let dir = TempDir::new().unwrap();
    let mut agent = agent();
    let file = path(&dir, "f.txt");
    ok_text(&mut agent, "write", json!({"path": file, "content": "hello\n"})).await;
    let error = err_text(
        &mut agent,
        "edit",
        json!({"path": file, "old_str": "missing", "new_str": "x"}),
    )
    .await;
    assert!(error.contains("did not appear verbatim"), "{error}");
}

#[tokio::test]
async fn rejects_an_edit_whose_old_str_is_not_unique() {
    let dir = TempDir::new().unwrap();
    let mut agent = agent();
    let file = path(&dir, "f.txt");
    ok_text(&mut agent, "write", json!({"path": file, "content": "dup\ndup\n"})).await;
    let error = err_text(
        &mut agent,
        "edit",
        json!({"path": file, "old_str": "dup", "new_str": "x"}),
    )
    .await;
    assert!(error.contains("appears 2 times"), "{error}");
}

#[tokio::test]
async fn edit_inserts_the_replacement_literally() {
    let dir = TempDir::new().unwrap();
    let mut agent = agent();
    let file = path(&dir, "run.sh");
    ok_text(&mut agent, "write", json!({"path": file, "content": "echo PID\n"})).await;
    ok_text(
        &mut agent,
        "edit",
        json!({"path": file, "old_str": "PID", "new_str": "$$ $& $'"}),
    )
    .await;
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "echo $$ $& $'\n");
}

#[tokio::test]
async fn returns_an_image_block_for_an_image_extension() {
    let dir = TempDir::new().unwrap();
    let mut agent = agent();
    let file = path(&dir, "pic.png");
    let bytes = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    std::fs::write(&file, &bytes).unwrap();
    let result = call(&mut agent, "read", json!({"path": file})).await;
    assert_eq!(image(&result), (ImageFormat::Png, bytes));
}

#[tokio::test]
async fn maps_a_jpg_extension_to_the_jpeg_format() {
    let dir = TempDir::new().unwrap();
    let mut agent = agent();
    let file = path(&dir, "photo.JPG");
    std::fs::write(&file, [0xff, 0xd8, 0xff, 0xe0]).unwrap();
    let result = call(&mut agent, "read", json!({"path": file})).await;
    assert_eq!(image(&result).0, ImageFormat::Jpeg);
}

#[tokio::test]
async fn image_format_follows_the_bytes_not_the_extension() {
    let cases: [(&str, &[u8], ImageFormat); 5] = [
        ("a.gif", &[0x47, 0x49, 0x46, 0x38, 0x39, 0x61], ImageFormat::Gif),
        ("b.gif", &[0x47, 0x49, 0x46, 0x38, 0x37, 0x61], ImageFormat::Gif),
        (
            "a.webp",
            &[
                0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38,
            ],
            ImageFormat::Webp,
        ),
        (
            "photo.jpg",
            &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
            ImageFormat::Png,
        ),
        ("shot.png", &[0xff, 0xd8, 0xff, 0xe0], ImageFormat::Jpeg),
    ];
    let dir = TempDir::new().unwrap();
    let mut agent = agent();
    for (name, bytes, expected) in cases {
        let file = path(&dir, name);
        std::fs::write(&file, bytes).unwrap();
        let result = call(&mut agent, "read", json!({"path": file})).await;
        assert_eq!(image(&result).0, expected, "{name}");
    }
}

#[tokio::test]
async fn rejects_non_image_bytes_under_an_image_extension() {
    let cases: [&[u8]; 4] = [
        b"this is text\n",
        b"",
        &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x58],
        &[0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45],
    ];
    let dir = TempDir::new().unwrap();
    let mut agent = agent();
    let file = path(&dir, "notes.png");
    for bytes in cases {
        std::fs::write(&file, bytes).unwrap();
        let message = format!(".png extension but its {} bytes are not", bytes.len());
        for tool in ["read", "read_media_off"] {
            let error = err_text(&mut agent, tool, json!({"path": file})).await;
            assert!(error.contains(&message), "{error}");
        }
    }
}

#[tokio::test]
async fn surfaces_a_non_image_as_an_error_tool_result_never_a_success_image_block() {
    let dir = TempDir::new().unwrap();
    let mut agent = agent();
    let file = path(&dir, "notes.png");
    std::fs::write(&file, "this is plain text\n").unwrap();
    let result = call(&mut agent, "read", json!({"path": file})).await;
    assert_eq!(result.status, ToolResultStatus::Error);
    assert_eq!(result.content.len(), 1);
    assert!(text(&result).contains("19 bytes are not a png, jpeg, gif, or webp image"));
}

#[tokio::test]
async fn returns_a_document_block_with_a_sanitized_name_for_a_binary_document() {
    let dir = TempDir::new().unwrap();
    let mut agent = agent();
    let file = path(&dir, "my report_v2.pdf");
    let bytes = vec![0x25, 0x50, 0x44, 0x46];
    std::fs::write(&file, &bytes).unwrap();
    let result = call(&mut agent, "read", json!({"path": file})).await;
    let [ToolResultContent::Document(document)] = result.content.as_slice() else {
        panic!("expected a document, got {result:?}");
    };
    assert_eq!(document.format, DocumentFormat::Pdf);
    assert_eq!(document.name, "my report v2 pdf");
    assert_eq!(document.source, DocumentSource::Bytes(bytes));
}

#[tokio::test]
async fn keeps_text_document_formats_on_the_numbered_lines_path() {
    let dir = TempDir::new().unwrap();
    let mut agent = agent();
    let file = path(&dir, "data.csv");
    ok_text(&mut agent, "write", json!({"path": file, "content": "a,b\n1,2\n"})).await;
    let out = ok_text(&mut agent, "read", json!({"path": file})).await;
    assert!(out.contains("     1\ta,b"));
}

#[tokio::test]
async fn rejects_a_relative_path() {
    let mut agent = agent();
    let error = err_text(&mut agent, "read", json!({"path": "relative/path"})).await;
    assert!(error.contains("not absolute"), "{error}");
}

#[tokio::test]
async fn rejects_path_traversal() {
    let mut agent = agent();
    let error = err_text(&mut agent, "read", json!({"path": "/tmp/../etc/passwd"})).await;
    assert!(error.contains("path traversal"), "{error}");
}

/// Records written paths and fails every other operation.
#[derive(Default)]
struct RecordingSandbox {
    written: Mutex<Vec<String>>,
}

#[async_trait]
impl Sandbox for RecordingSandbox {
    fn execute_streaming(&self, _command: &str, _options: ExecuteOptions) -> ExecutionStream {
        Box::pin(futures::stream::empty())
    }

    fn execute_code_streaming(&self, _code: &str, _language: &str, _options: ExecuteOptions) -> ExecutionStream {
        Box::pin(futures::stream::empty())
    }

    async fn read_file(&self, _path: &str) -> strands::Result<Vec<u8>> {
        Err(strands::Error::other("unsupported"))
    }

    async fn write_file(&self, path: &str, _content: &[u8]) -> strands::Result<()> {
        self.written.lock().unwrap().push(path.to_owned());
        Ok(())
    }

    async fn remove_file(&self, _path: &str) -> strands::Result<()> {
        Err(strands::Error::other("unsupported"))
    }

    async fn list_files(&self, _path: &str) -> strands::Result<Vec<FileInfo>> {
        Err(strands::Error::other("unsupported"))
    }
}

#[tokio::test]
async fn accepts_windows_drive_letter_paths_as_absolute() {
    let sandbox = Arc::new(RecordingSandbox::default());
    let mut agent = Agent::builder()
        .model(MockModel::new())
        .tools([write_tool()])
        .sandbox(sandbox.clone() as Arc<dyn Sandbox>)
        .printer(false)
        .build()
        .unwrap();
    for file in [
        "C:\\Users\\me\\novel.json",
        "C:/Users/me/novel.json",
        "\\\\server\\share\\novel.json",
    ] {
        ok_text(&mut agent, "write", json!({"path": file, "content": "{}"})).await;
    }
    assert_eq!(
        *sandbox.written.lock().unwrap(),
        [
            "C:\\Users\\me\\novel.json",
            "C:/Users/me/novel.json",
            "\\\\server\\share\\novel.json"
        ]
    );
    let error = err_text(&mut agent, "write", json!({"path": "C:novel.json", "content": ""})).await;
    assert!(error.contains("not absolute"), "{error}");
    let error = err_text(
        &mut agent,
        "write",
        json!({"path": "C:\\Users\\..\\secret", "content": ""}),
    )
    .await;
    assert!(error.contains("path traversal"), "{error}");
}

#[tokio::test]
async fn returns_media_for_a_capable_model() {
    let dir = TempDir::new().unwrap();
    let mut agent = agent();
    let file = path(&dir, "shot.png");
    std::fs::write(&file, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).unwrap();
    let result = call(&mut agent, "read", json!({"path": file})).await;
    assert_eq!(image(&result).0, ImageFormat::Png);
}

#[tokio::test]
async fn describes_an_image_in_text_when_media_is_off() {
    let dir = TempDir::new().unwrap();
    let mut agent = agent();
    let file = path(&dir, "shot.png");
    std::fs::write(&file, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).unwrap();
    let out = ok_text(&mut agent, "read_media_off", json!({"path": file})).await;
    assert_eq!(
        out,
        format!(
            "[Image file: {file} (png, 8 bytes). This model cannot view image files, so its contents are not shown. Use shell tools if the file has a text-extractable form.]"
        )
    );
}

#[tokio::test]
async fn describes_a_document_in_text_when_media_is_off() {
    let dir = TempDir::new().unwrap();
    let mut agent = agent();
    let file = path(&dir, "spec.pdf");
    std::fs::write(&file, [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]).unwrap();
    let out = ok_text(&mut agent, "read_media_off", json!({"path": file})).await;
    assert!(out.contains("pdf"));
    assert!(out.starts_with("[Document file: "));
}

#[tokio::test]
async fn leaves_text_reads_untouched_when_media_is_off() {
    let dir = TempDir::new().unwrap();
    let mut agent = agent();
    let file = path(&dir, "f.txt");
    ok_text(&mut agent, "write", json!({"path": file, "content": "alpha\nbeta\n"})).await;
    let out = ok_text(&mut agent, "read_media_off", json!({"path": file})).await;
    assert!(out.contains("     1\talpha"));
}

#[test]
fn reports_an_offset_past_the_end_and_the_write_line_count() {
    assert_eq!(
        numbered_window("a\nb", Some(5.0), None),
        "[File has 2 lines; offset 5 is past the end.]"
    );
    assert_eq!(numbered_window("a\nb", None, None), "     1\ta\n     2\tb");
}

#[test]
fn specs_match_harness_ts() {
    let expected = [
        (
            read_tool(true).tool_spec(),
            r#"{"name":"read","description":"Read a file. Text returns `cat -n` style numbered lines so you can cite `path:line`; images (png/jpg/jpeg/gif/webp) and binary documents (pdf/doc/docx/xls/xlsx) return media you can view directly. Text defaults to the first 2000 lines; use offset/limit to page through larger files.","inputSchema":{"type":"object","properties":{"path":{"type":"string","description":"Absolute path to the file."},"offset":{"description":"1-indexed line to start from. Defaults to the first line. Text files only.","type":"number"},"limit":{"description":"Maximum number of lines to return. Defaults to 2000. Text files only.","type":"number"}},"required":["path"],"additionalProperties":false}}"#,
        ),
        (
            write_tool().tool_spec(),
            r#"{"name":"write","description":"Write a file, creating it or overwriting it. Use `edit` for surgical changes to a large file.","inputSchema":{"type":"object","properties":{"path":{"type":"string","description":"Absolute path to the file."},"content":{"type":"string","description":"The full file content to write."}},"required":["path","content"],"additionalProperties":false}}"#,
        ),
        (
            edit_tool().tool_spec(),
            r#"{"name":"edit","description":"Replace an exact string in a file. `old_str` must appear exactly once.","inputSchema":{"type":"object","properties":{"path":{"type":"string","description":"Absolute path to the file."},"old_str":{"type":"string","description":"Exact text to find. Must be unique within the file."},"new_str":{"type":"string","description":"Replacement text."}},"required":["path","old_str","new_str"],"additionalProperties":false}}"#,
        ),
    ];
    for (spec, json) in expected {
        assert_eq!(serde_json::to_string(&spec).unwrap(), json);
    }
}

#[test]
fn exposes_only_command_and_timeout_with_no_mode_discriminator() {
    let spec = shell_tool(None).unwrap().tool_spec();
    let schema = spec.input_schema.unwrap();
    let mut keys: Vec<&String> = schema["properties"].as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(keys, ["command", "timeout"]);
    assert_eq!(schema["required"], json!(["command"]));
    assert!(schema["properties"].get("mode").is_none());
}

#[tokio::test]
async fn runs_a_command_through_the_agent_sandbox() {
    let mut agent = agent_with(vec![shell_tool(None).unwrap()]);
    let result = call(&mut agent, "shell", json!({"command": "echo hello"})).await;
    let output: Value = match result.content.as_slice() {
        [ToolResultContent::Json(json)] => json.json.clone(),
        other => panic!("expected json, got {other:?}"),
    };
    assert!(output["output"].as_str().unwrap().contains("hello"));
}

#[tokio::test]
async fn is_stateless_state_does_not_persist_across_calls() {
    let mut agent = agent_with(vec![shell_tool(None).unwrap()]);
    call(&mut agent, "shell", json!({"command": "export STRANDS_CLI_TEST=42"})).await;
    let result = call(&mut agent, "shell", json!({"command": "echo \"[$STRANDS_CLI_TEST]\""})).await;
    let [ToolResultContent::Json(json)] = result.content.as_slice() else {
        panic!("expected json, got {result:?}");
    };
    assert!(json.json["output"].as_str().unwrap().contains("[]"));
}

#[test]
fn shell_takes_the_configured_description() {
    let shell = shell_tool(Some("Run it.".to_owned())).unwrap();
    assert_eq!(shell.description(), "Run it.");
}
