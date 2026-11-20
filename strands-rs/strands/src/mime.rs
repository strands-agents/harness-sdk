//! MIME type mapping for media formats.
//!
//! Crate-internal; providers use it to format media blocks.

const TO_MIME_TYPE: [(&str, &str); 25] = [
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("mkv", "video/x-matroska"),
    ("mov", "video/quicktime"),
    ("mp4", "video/mp4"),
    ("webm", "video/webm"),
    ("flv", "video/x-flv"),
    ("mpeg", "video/mpeg"),
    ("mpg", "video/mpeg"),
    ("wmv", "video/x-ms-wmv"),
    ("3gp", "video/3gpp"),
    ("pdf", "application/pdf"),
    ("csv", "text/csv"),
    ("doc", "application/msword"),
    (
        "docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ),
    ("xls", "application/vnd.ms-excel"),
    (
        "xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ),
    ("html", "text/html"),
    ("txt", "text/plain"),
    ("md", "text/markdown"),
    ("json", "application/json"),
    ("xml", "application/xml"),
];

const TO_MEDIA_FORMAT: [(&str, &str); 23] = [
    ("image/png", "png"),
    ("image/jpeg", "jpeg"),
    ("image/gif", "gif"),
    ("image/webp", "webp"),
    ("video/x-matroska", "mkv"),
    ("video/quicktime", "mov"),
    ("video/mp4", "mp4"),
    ("video/webm", "webm"),
    ("video/x-flv", "flv"),
    ("video/mpeg", "mpeg"),
    ("video/x-ms-wmv", "wmv"),
    ("video/3gpp", "3gp"),
    ("application/pdf", "pdf"),
    ("text/csv", "csv"),
    ("application/msword", "doc"),
    (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "docx",
    ),
    ("application/vnd.ms-excel", "xls"),
    (
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xlsx",
    ),
    ("text/html", "html"),
    ("text/plain", "txt"),
    ("text/markdown", "md"),
    ("application/json", "json"),
    ("application/xml", "xml"),
];

fn lookup(table: &[(&str, &'static str)], key: &str) -> Option<&'static str> {
    table
        .iter()
        .find_map(|(from, to)| from.eq_ignore_ascii_case(key).then_some(*to))
}

/// The MIME type of a media format, case-insensitively.
#[allow(
    dead_code,
    reason = "only providers format media blocks with it; unused without provider features"
)]
pub(crate) fn to_mime_type(format: &str) -> Option<&'static str> {
    lookup(&TO_MIME_TYPE, format)
}

/// The canonical media format of a MIME type, case-insensitively.
#[allow(
    dead_code,
    reason = "only providers parse media responses with it; unused without provider features"
)]
pub(crate) fn to_media_format(mime_type: &str) -> Option<&'static str> {
    lookup(&TO_MEDIA_FORMAT, mime_type)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_mime_type_converts_each_format() {
        for (format, mime_type) in TO_MIME_TYPE {
            assert_eq!(to_mime_type(format), Some(mime_type), "{format}");
        }
        assert_eq!(to_mime_type("3gp"), Some("video/3gpp"));
    }

    #[test]
    fn to_mime_type_is_case_insensitive() {
        assert_eq!(to_mime_type("PNG"), Some("image/png"));
        assert_eq!(to_mime_type("Mp4"), Some("video/mp4"));
        assert_eq!(to_mime_type("PDF"), Some("application/pdf"));
    }

    #[test]
    fn to_mime_type_returns_undefined_for_unknown_formats() {
        assert_eq!(to_mime_type("unknown"), None);
        assert_eq!(to_mime_type("bmp"), None);
        assert_eq!(to_mime_type(""), None);
    }

    #[test]
    fn to_media_format_converts_each_mime_type() {
        for (mime_type, format) in TO_MEDIA_FORMAT {
            assert_eq!(to_media_format(mime_type), Some(format), "{mime_type}");
        }
        assert_eq!(to_media_format("image/jpeg"), Some("jpeg"));
    }

    #[test]
    fn to_media_format_is_case_insensitive() {
        assert_eq!(to_media_format("IMAGE/PNG"), Some("png"));
        assert_eq!(to_media_format("Video/Mp4"), Some("mp4"));
        assert_eq!(to_media_format("Application/PDF"), Some("pdf"));
    }

    #[test]
    fn to_media_format_returns_undefined_for_unknown_mime_types() {
        assert_eq!(to_media_format("image/bmp"), None);
        assert_eq!(to_media_format("application/octet-stream"), None);
        assert_eq!(to_media_format(""), None);
    }
}
