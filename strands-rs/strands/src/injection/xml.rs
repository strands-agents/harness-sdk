//! Minimal XML escaping for folding untrusted text into an XML-shaped block.
//!
//! Memory entries and other injected content are often user-derived; interpolating them raw would
//! break the block (a stray `</entry>` or `"`) and open a stored-prompt-injection surface.

/// Escapes text for element content: `&` first, so later replacements are not double-escaped,
/// then `<` and `>`.
pub(crate) fn escape_xml_text(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Escapes a value for a double-quoted attribute: the text rules plus `"` and `'`.
pub(crate) fn escape_xml_attr(value: &str) -> String {
    escape_xml_text(value).replace('"', "&quot;").replace('\'', "&#39;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_ampersand_first_then_angle_brackets() {
        assert_eq!(
            escape_xml_text("a < b & c > d &lt;"),
            "a &lt; b &amp; c &gt; d &amp;lt;"
        );
    }

    #[test]
    fn escapes_quotes_in_attributes() {
        assert_eq!(escape_xml_attr(r#"pre"f'x<"#), "pre&quot;f&#39;x&lt;");
    }
}
