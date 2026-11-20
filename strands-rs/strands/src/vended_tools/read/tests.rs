#![cfg(unix)]
//! Runs against the host filesystem through [`NotASandboxLocalEnvironment`]. POSIX paths, so Unix
//! only.

use std::path::Path;

use serde_json::json;
use tempfile::TempDir;

use super::*;
use crate::sandbox::NotASandboxLocalEnvironment;
use crate::tools::Tool;
use crate::types::{ToolResultBlock, ToolResultStatus};
use crate::vended_tools::test_support::{agent, error_text, ok_text, run};

const PNG_BYTES: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_BYTES: &[u8] = &[0xff, 0xd8, 0xff, 0xe0];

fn reader() -> FunctionTool {
    make_read(MakeReadOptions {
        sandbox: Some(Arc::new(NotASandboxLocalEnvironment::new())),
        ..MakeReadOptions::default()
    })
}

fn reader_text_only() -> FunctionTool {
    make_read(MakeReadOptions {
        sandbox: Some(Arc::new(NotASandboxLocalEnvironment::new())),
        media: Some(false),
        ..MakeReadOptions::default()
    })
}

fn file(dir: &TempDir, name: &str, data: &[u8]) -> String {
    let path = dir.path().join(name);
    std::fs::write(&path, data).unwrap();
    path_text(&path)
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn concat(parts: &[&[u8]]) -> Vec<u8> {
    parts.concat()
}

async fn read_ok(tool: &FunctionTool, input: JsonValue) -> String {
    ok_text(tool, input, &agent()).await
}

async fn read_err(tool: &FunctionTool, input: JsonValue) -> String {
    error_text(tool, input, &agent()).await
}

async fn read_result(tool: &FunctionTool, path: &str) -> ToolResultBlock {
    run(tool, json!({"path": path}), &agent()).await
}

async fn image_format(tool: &FunctionTool, path: &str) -> ImageFormat {
    let result = read_result(tool, path).await;
    match result.content.as_slice() {
        [ToolResultContent::Image(image)] => image.format,
        other => panic!("expected an image, got {other:?}"),
    }
}

#[tokio::test]
async fn returns_numbered_lines() {
    let dir = tempfile::tempdir().unwrap();
    let path = file(&dir, "f.txt", b"alpha\nbeta\n");
    assert_eq!(
        read_ok(&reader(), json!({"path": path})).await,
        "     1\talpha\n     2\tbeta\n     3\t"
    );
}

#[tokio::test]
async fn offset_and_limit_page_through_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let content: Vec<String> = (1..=10).map(|index| format!("line{index}")).collect();
    let path = file(&dir, "f.txt", content.join("\n").as_bytes());
    assert_eq!(
        read_ok(&reader(), json!({"path": path, "offset": 3, "limit": 2})).await,
        "     3\tline3\n     4\tline4\n[Showing lines 3-4 of 10. Use offset/limit to read more.]"
    );
}

#[tokio::test]
async fn offset_past_the_end_returns_a_message() {
    let dir = tempfile::tempdir().unwrap();
    let path = file(&dir, "f.txt", b"one\ntwo\n");
    assert_eq!(
        read_ok(&reader(), json!({"path": path, "offset": 100})).await,
        "[File has 3 lines; offset 100 is past the end.]"
    );
}

#[tokio::test]
async fn png_returns_image_content() {
    let dir = tempfile::tempdir().unwrap();
    let bytes = concat(&[PNG_BYTES, b"fake"]);
    let path = file(&dir, "pic.png", &bytes);
    let result = read_result(&reader(), &path).await;
    assert_eq!(
        result,
        ToolResultBlock::success(
            "test-id",
            vec![ToolResultContent::Image(ImageBlock::new(
                ImageFormat::Png,
                ImageSource::Bytes(bytes)
            ))]
        )
    );
}

#[tokio::test]
async fn jpg_extension_maps_to_jpeg_format() {
    let dir = tempfile::tempdir().unwrap();
    let path = file(&dir, "photo.JPG", &concat(&[JPEG_BYTES, b"fake"]));
    assert_eq!(image_format(&reader(), &path).await, ImageFormat::Jpeg);
}

#[tokio::test]
async fn format_follows_bytes_not_extension() {
    let cases: [(&str, Vec<u8>, ImageFormat); 5] = [
        ("a.gif", b"GIF89a fake".to_vec(), ImageFormat::Gif),
        ("b.gif", b"GIF87a fake".to_vec(), ImageFormat::Gif),
        (
            "a.webp",
            concat(&[b"RIFF", &[0; 4], b"WEBPVP8 fake"]),
            ImageFormat::Webp,
        ),
        ("photo.jpg", concat(&[PNG_BYTES, b"fake"]), ImageFormat::Png),
        ("shot.png", concat(&[JPEG_BYTES, b"fake"]), ImageFormat::Jpeg),
    ];
    let dir = tempfile::tempdir().unwrap();
    for (name, data, expected) in cases {
        let path = file(&dir, name, &data);
        assert_eq!(image_format(&reader(), &path).await, expected, "{name}");
    }
}

#[tokio::test]
async fn rejects_non_image_bytes_under_an_image_extension() {
    let cases: [Vec<u8>; 4] = [
        b"this is plain text\n".to_vec(),
        Vec::new(),
        concat(&[
            &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x58],
            b"truncated signature",
        ]),
        concat(&[b"RIFF", &[0; 4], b"WAVE"]),
    ];
    let dir = tempfile::tempdir().unwrap();
    for data in cases {
        let path = file(&dir, "notes.png", &data);
        let message = format!(
            "{path} has a .png extension but its {} bytes are not a png, jpeg, gif, or webp image. If a shell tool is available, use it to identify or extract text.",
            data.len()
        );
        assert_eq!(read_err(&reader(), json!({"path": path})).await, message);
        assert_eq!(read_err(&reader_text_only(), json!({"path": path})).await, message);
    }
}

#[tokio::test]
async fn a_rejected_non_image_surfaces_as_an_error_tool_result() {
    let dir = tempfile::tempdir().unwrap();
    let path = file(&dir, "notes.png", b"this is plain text\n");
    let result = read_result(&reader(), &path).await;
    assert_eq!(result.status, ToolResultStatus::Error);
    let [ToolResultContent::Text(text)] = result.content.as_slice() else {
        panic!("expected one text block, got {:?}", result.content);
    };
    assert!(text.text.contains("19 bytes are not a png, jpeg, gif, or webp image"));
}

#[tokio::test]
async fn pdf_returns_document_content() {
    let dir = tempfile::tempdir().unwrap();
    let bytes = b"%PDF-1.4 fake".to_vec();
    let path = file(&dir, "my report_v2.pdf", &bytes);
    let result = read_result(&reader(), &path).await;
    assert_eq!(
        result,
        ToolResultBlock::success(
            "test-id",
            vec![ToolResultContent::Document(DocumentBlock::new(
                "my report v2 pdf",
                DocumentFormat::Pdf,
                DocumentSource::Bytes(bytes)
            ))]
        )
    );
}

#[tokio::test]
async fn text_representable_formats_stay_on_the_numbered_path() {
    let dir = tempfile::tempdir().unwrap();
    let path = file(&dir, "data.csv", b"a,b\n1,2\n");
    assert_eq!(
        read_ok(&reader(), json!({"path": path})).await,
        "     1\ta,b\n     2\t1,2\n     3\t"
    );
}

#[tokio::test]
async fn rejects_mislabeled_document_bytes() {
    let cases: [(&str, Vec<u8>); 5] = [
        ("notes.pdf", b"this is plain text\n".to_vec()),
        ("zipped.pdf", concat(&[ZIP, b"fake"])),
        ("sheet.xlsx", b"this is plain text\n".to_vec()),
        ("ole.xlsx", concat(&[OLE2, b"fake"])),
        ("legacy.doc", concat(&[ZIP, b"fake"])),
    ];
    let dir = tempfile::tempdir().unwrap();
    for (name, data) in cases {
        let path = file(&dir, name, &data);
        let ext = name.rsplit('.').next().unwrap();
        let message = format!(
            "{path} has a .{ext} extension but its {} bytes are not a valid {ext} document. If a shell tool is available, use it to identify or extract text.",
            data.len()
        );
        assert_eq!(read_err(&reader(), json!({"path": path})).await, message);
        assert_eq!(read_err(&reader_text_only(), json!({"path": path})).await, message);
    }
}

#[tokio::test]
async fn describes_an_image_as_text() {
    let dir = tempfile::tempdir().unwrap();
    let path = file(&dir, "shot.png", &concat(&[PNG_BYTES, b"fake"]));
    assert_eq!(
        read_ok(&reader_text_only(), json!({"path": path})).await,
        format!(
            "[Image file: {path} (png, 12 bytes). This model cannot view image files, so its contents are not shown. If a shell tool is available, use it when the file has a text-extractable form.]"
        )
    );
}

#[tokio::test]
async fn describes_a_document_as_text() {
    let dir = tempfile::tempdir().unwrap();
    let path = file(&dir, "spec.pdf", b"%PDF-1.7 fake");
    assert_eq!(
        read_ok(&reader_text_only(), json!({"path": path})).await,
        format!(
            "[Document file: {path} (pdf, 13 bytes). This model cannot view document files, so its contents are not shown. If a shell tool is available, use it when the file has a text-extractable form.]"
        )
    );
}

#[tokio::test]
async fn leaves_text_reads_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let path = file(&dir, "f.txt", b"alpha\nbeta\n");
    assert_eq!(
        read_ok(&reader_text_only(), json!({"path": path})).await,
        "     1\talpha\n     2\tbeta\n     3\t"
    );
}

#[tokio::test]
async fn rejects_a_relative_path() {
    assert!(
        read_err(&reader(), json!({"path": "relative/path"}))
            .await
            .contains("not absolute")
    );
}

#[tokio::test]
async fn rejects_path_traversal() {
    assert!(
        read_err(&reader(), json!({"path": "/tmp/../etc/passwd"}))
            .await
            .contains("path traversal")
    );
}

#[tokio::test]
async fn rejects_a_window_exceeding_max_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = file(&dir, "big.txt", "x".repeat(1_048_576 + 1).as_bytes());
    assert!(
        read_err(&reader(), json!({"path": path}))
            .await
            .contains("exceeding the 1048576-byte limit")
    );
}

#[tokio::test]
async fn rejects_an_oversize_image() {
    let dir = tempfile::tempdir().unwrap();
    let path = file(
        &dir,
        "huge.png",
        &concat(&[PNG_BYTES, "x".repeat(10_485_760 + 1).as_bytes()]),
    );
    assert!(
        read_err(&reader(), json!({"path": path}))
            .await
            .contains("exceeding the 10485760-byte limit for image reads")
    );
    assert!(
        read_ok(&reader_text_only(), json!({"path": path}))
            .await
            .starts_with("[Image file:")
    );
}

#[tokio::test]
async fn rejects_an_oversize_document() {
    let dir = tempfile::tempdir().unwrap();
    let path = file(
        &dir,
        "huge.pdf",
        &concat(&[b"%PDF-", "x".repeat(10_485_760 + 1).as_bytes()]),
    );
    assert!(
        read_err(&reader(), json!({"path": path}))
            .await
            .contains("exceeding the 10485760-byte limit for document reads")
    );
    assert!(
        read_ok(&reader_text_only(), json!({"path": path}))
            .await
            .starts_with("[Document file:")
    );
}

#[tokio::test]
async fn max_bytes_is_configurable() {
    let dir = tempfile::tempdir().unwrap();
    let path = file(&dir, "f.txt", "x".repeat(2000).as_bytes());
    let sized = |max_bytes| {
        make_read(MakeReadOptions {
            sandbox: Some(Arc::new(NotASandboxLocalEnvironment::new())),
            max_bytes: Some(max_bytes),
            ..MakeReadOptions::default()
        })
    };
    assert!(
        read_err(&sized(1000), json!({"path": path}))
            .await
            .contains("exceeding the 1000-byte limit")
    );
    assert_eq!(
        read_ok(&sized(4096), json!({"path": path})).await,
        format!("     1\t{}", "x".repeat(2000))
    );
}

#[tokio::test]
async fn max_media_bytes_is_configurable() {
    let dir = tempfile::tempdir().unwrap();
    let path = file(&dir, "pic.png", &concat(&[PNG_BYTES, "x".repeat(1000).as_bytes()]));
    let small = make_read(MakeReadOptions {
        sandbox: Some(Arc::new(NotASandboxLocalEnvironment::new())),
        max_media_bytes: Some(500),
        ..MakeReadOptions::default()
    });
    assert!(
        read_err(&small, json!({"path": path}))
            .await
            .contains("exceeding the 500-byte limit for image reads")
    );
}

#[tokio::test]
async fn keeps_a_leading_byte_order_mark() {
    let dir = tempfile::tempdir().unwrap();
    let path = file(&dir, "bom.txt", &concat(&[&[0xef, 0xbb, 0xbf], b"hello\n"]));
    assert_eq!(
        read_ok(&reader(), json!({"path": path})).await,
        "     1\t\u{FEFF}hello\n     2\t"
    );
}

#[tokio::test]
async fn raises_a_clear_error() {
    let dir = tempfile::tempdir().unwrap();
    let path = file(&dir, "data.txt", &concat(&[b"valid\n", &[0xe9, 0xff, 0xfe, 0x0a]]));
    assert_eq!(
        read_err(&reader(), json!({"path": path})).await,
        format!("{path} is not UTF-8 text. If a shell tool is available, inspect it there.")
    );
}

#[tokio::test]
async fn rejects_non_positive_offset() {
    let dir = tempfile::tempdir().unwrap();
    let path = file(&dir, "f.txt", b"one\n");
    for offset in [0, -1, -100] {
        let message = read_err(&reader(), json!({"path": path, "offset": offset})).await;
        assert!(
            message.contains("offset must be a positive 1-indexed line number"),
            "{message}"
        );
    }
}

#[tokio::test]
async fn rejects_non_positive_limit() {
    let dir = tempfile::tempdir().unwrap();
    let path = file(&dir, "f.txt", b"one\n");
    for limit in [0, -1, -100] {
        let message = read_err(&reader(), json!({"path": path, "limit": limit})).await;
        assert!(message.contains("limit must be a positive line count"), "{message}");
    }
}

#[tokio::test]
async fn offset_and_limit_must_be_integers() {
    let dir = tempfile::tempdir().unwrap();
    let path = file(&dir, "f.txt", b"one\ntwo\n");
    read_err(&reader(), json!({"path": path, "offset": 1.5})).await;
    read_err(&reader(), json!({"path": path, "limit": 2.5})).await;
}

#[tokio::test]
async fn accepts_integer_valued_float_offset_and_limit() {
    let dir = tempfile::tempdir().unwrap();
    let content: Vec<String> = (1..=10).map(|index| format!("line{index}")).collect();
    let path = file(&dir, "f.txt", content.join("\n").as_bytes());
    assert_eq!(
        read_ok(&reader(), json!({"path": path, "offset": 3.0, "limit": 2.0})).await,
        "     3\tline3\n     4\tline4\n[Showing lines 3-4 of 10. Use offset/limit to read more.]"
    );
}

#[tokio::test]
async fn uses_the_agent_sandbox_when_unbound() {
    let dir = tempfile::tempdir().unwrap();
    let path = file(&dir, "f.txt", b"hello\n");
    assert_eq!(
        ok_text(&read(), json!({"path": path}), &agent()).await,
        "     1\thello\n     2\t"
    );
}

#[test]
fn default_description_appends_the_media_suffix() {
    assert_eq!(
        make_read(MakeReadOptions::default()).description(),
        "Read a file. Text returns `cat -n` style numbered lines so you can cite `path:line`. Files must use absolute paths. Images (png/jpg/jpeg/gif/webp) and binary documents (pdf/doc/docx/xls/xlsx) return media you can view directly."
    );
}

#[test]
fn media_off_description_omits_the_media_suffix() {
    let tool = make_read(MakeReadOptions::builder().media(false).build());
    assert_eq!(tool.description(), DEFAULT_READ_DESCRIPTION);
}

#[test]
fn explicit_description_wins() {
    let tool = make_read(MakeReadOptions::builder().media(false).description("Custom.").build());
    assert_eq!(tool.description(), "Custom.");
}
