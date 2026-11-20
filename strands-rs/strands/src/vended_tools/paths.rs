//! Path validation shared by the sandbox-routed file tools.

use crate::error::{Error, Result};

/// Whether `path` starts with a Windows drive letter (`C:\`, `C:/`) or a UNC share (`\\server`).
fn is_windows_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    if path.starts_with("\\\\") {
        return true;
    }
    bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'\\' | b'/')
}

/// Rejects a path that is not absolute (POSIX, or a Windows drive letter or UNC share) or that
/// has a `..` segment. Both `/` and `\` separate segments, so a
/// backslash cannot hide a traversal.
///
/// ```
/// use strands::vended_tools::paths::validate_absolute_path;
///
/// assert!(validate_absolute_path("/tmp/notes.txt").is_ok());
/// assert!(validate_absolute_path("notes.txt").is_err());
/// assert!(validate_absolute_path("/tmp/../etc/passwd").is_err());
/// ```
///
/// # Errors
///
/// When the path is relative, or contains a `..` segment.
pub fn validate_absolute_path(path: &str) -> Result<()> {
    if !(path.starts_with('/') || is_windows_absolute(path)) {
        return Err(Error::other(format!(
            "The path {path} is not absolute; it should start with '/' (or a drive letter or UNC share on Windows)."
        )));
    }
    if path.split(['/', '\\']).any(|segment| segment == "..") {
        return Err(Error::other("Invalid path: path traversal is not allowed."));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(path: &str) -> String {
        validate_absolute_path(path).unwrap_err().to_string()
    }

    #[test]
    fn accepts_a_posix_absolute_path() {
        validate_absolute_path("/tmp/file.txt").unwrap();
    }

    #[test]
    fn accepts_a_windows_drive_letter_absolute_path() {
        validate_absolute_path("C:\\project\\file.txt").unwrap();
        validate_absolute_path("c:/project/file.txt").unwrap();
    }

    #[test]
    fn accepts_a_unc_share() {
        validate_absolute_path("\\\\server\\share\\file.txt").unwrap();
    }

    #[test]
    fn rejects_a_relative_path() {
        assert!(message("relative.txt").contains("not absolute"));
        assert!(message("C:relative.txt").contains("not absolute"));
    }

    #[test]
    fn rejects_posix_parent_traversal() {
        assert!(message("/tmp/../etc/passwd").contains("path traversal is not allowed"));
    }

    #[test]
    fn rejects_windows_parent_traversal() {
        assert!(message("C:\\project\\..\\etc\\hosts").contains("path traversal is not allowed"));
    }

    #[test]
    fn accepts_a_double_dot_substring_inside_a_segment() {
        validate_absolute_path("/tmp/file..name.txt").unwrap();
    }
}
