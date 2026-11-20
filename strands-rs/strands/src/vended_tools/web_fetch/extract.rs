//! HTML to markdown for the web fetch tool, on `htmd` (a turndown port) with these options and
//! rules: ATX headings, fenced code, `-` bullets, inline links; non-content elements dropped; the
//! `<title>` as a top-level heading; `data:` images reduced to their alt text; `javascript:` and
//! `vbscript:` links and images stripped.

use std::sync::LazyLock;

use htmd::element_handler::{HandlerResult, Handlers};
use htmd::options::{BulletListMarker, CodeBlockStyle, HeadingStyle, LinkStyle, Options};
use htmd::{Element, HtmlToMarkdown};
use regex::Regex;

const DROPPED_ELEMENTS: [&str; 17] = [
    "script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "embed", "video", "audio", "form",
    "input", "button", "select", "textarea", "nav",
];

static CONVERTER: LazyLock<HtmlToMarkdown> = LazyLock::new(|| {
    HtmlToMarkdown::builder()
        .options(Options {
            heading_style: HeadingStyle::Atx,
            code_block_style: CodeBlockStyle::Fenced,
            bullet_list_marker: BulletListMarker::Dash,
            link_style: LinkStyle::Inlined,
            ..Options::default()
        })
        .skip_tags(DROPPED_ELEMENTS.to_vec())
        .add_handler(vec!["title"], title)
        .add_handler(vec!["img"], safe_image)
        .add_handler(vec!["a"], safe_link)
        .build()
});

/// The control, format and space-separator characters (`\p{Cc}\p{Cf}\p{Zs}`) before a URL, from
/// the Unicode tables of the `regex` crate.
static INVISIBLE_PREFIX: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"^[\p{Cc}\p{Cf}\p{Zs}]+").ok());

/// `value` without the invisible characters before it.
fn strip_invisible(value: &str) -> &str {
    let start = INVISIBLE_PREFIX
        .as_ref()
        .and_then(|pattern| pattern.find(value))
        .map_or(0, |prefix| prefix.end());
    value.get(start..).unwrap_or(value)
}

/// The scheme of an absolute URL, after the invisible characters before it.
fn scheme(value: &str) -> Option<String> {
    let url = reqwest::Url::parse(strip_invisible(value)).ok()?;
    Some(url.scheme().to_owned())
}

fn attribute(element: &Element<'_>, name: &str) -> Option<String> {
    element
        .attrs
        .iter()
        .find(|attr| &*attr.name.local == name)
        .map(|attr| attr.value.to_string())
}

#[allow(clippy::needless_pass_by_value, reason = "the htmd handler signature")]
fn title(handlers: &dyn Handlers, element: Element<'_>) -> Option<HandlerResult> {
    let text = handlers.walk_children(element.node).content;
    let text = text.trim();
    if text.is_empty() {
        return Some("".into());
    }
    Some(format!("# {text}\n\n").into())
}

#[allow(clippy::needless_pass_by_value, reason = "the htmd handler signature")]
fn safe_image(_handlers: &dyn Handlers, element: Element<'_>) -> Option<HandlerResult> {
    let src = attribute(&element, "src").unwrap_or_default();
    let src = src.trim();
    let alt = attribute(&element, "alt").unwrap_or_default();
    if src.is_empty() {
        return Some(alt.into());
    }
    match scheme(src).as_deref() {
        Some("javascript" | "vbscript") => Some("".into()),
        Some("data") => Some(alt.into()),
        _ => Some(format!("![{alt}]({src})").into()),
    }
}

fn safe_link(handlers: &dyn Handlers, element: Element<'_>) -> Option<HandlerResult> {
    let href = attribute(&element, "href").unwrap_or_default();
    if matches!(scheme(href.trim()).as_deref(), Some("javascript" | "vbscript" | "data")) {
        return Some(handlers.walk_children(element.node));
    }
    handlers.fallback(element)
}

/// Converts HTML to markdown for a model to read: trimmed, with one trailing
/// newline, or empty. When conversion fails the HTML comes back unchanged.
pub(crate) fn html_to_markdown(html: &str) -> String {
    match CONVERTER.convert(html) {
        Ok(markdown) => {
            let markdown = markdown.trim();
            if markdown.is_empty() {
                String::new()
            } else {
                format!("{markdown}\n")
            }
        }
        Err(error) => {
            tracing::warn!("error=<{error}> | html_to_markdown failed, returning raw html");
            html.to_owned()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_script_and_style_content() {
        let html = "<html><head><title>Hi</title>\n<style>body{color:red}</style>\n</head><body>\n<p>Hello world.</p>\n<script>alert('xss')</script>\n<p>After script.</p>\n</body></html>";
        let result = html_to_markdown(html);
        assert!(result.contains("# Hi"), "{result}");
        assert!(!result.contains("alert") && !result.contains("color:red"), "{result}");
        assert!(
            result.contains("Hello world.") && result.contains("After script."),
            "{result}"
        );
    }

    #[test]
    fn drops_element_entirely() {
        for tag in ["nav", "form", "iframe", "svg", "canvas", "video", "audio"] {
            let result = html_to_markdown(&format!("<p>before</p><{tag}>secret content</{tag}><p>after</p>"));
            assert!(!result.contains("secret content"), "{tag}: {result}");
            assert!(result.contains("before") && result.contains("after"), "{tag}: {result}");
        }
    }

    #[test]
    fn strips_data_uri_image_blobs() {
        let blob = "A".repeat(10_000);
        let result = html_to_markdown(&format!(
            "<p>text</p><img src=\"data:image/png;base64,{blob}\" alt=\"alt text\">"
        ));
        assert!(!result.contains(&blob) && !result.contains("data:"), "{result}");
        assert!(result.contains("alt text"), "{result}");
    }

    #[test]
    fn preserves_regular_images_and_relative_hrefs() {
        assert!(
            html_to_markdown("<img src=\"https://example.com/pic.png\" alt=\"pic\">")
                .contains("![pic](https://example.com/pic.png)")
        );
        assert!(html_to_markdown("<a href=\"/about\">About</a>").contains("[About](/about)"));
    }

    #[test]
    fn drops_javascript_hrefs_but_keeps_link_text() {
        let result = html_to_markdown("<a href=\"javascript:alert(1)\">click</a>");
        assert!(!result.contains("javascript:") && result.contains("click"), "{result}");
    }

    #[test]
    fn drops_javascript_href_with_invisible_prefix() {
        for prefix in [
            "\u{200b}",
            "\u{00ad}",
            "\u{feff}",
            " ",
            "\u{e0020}",
            "\u{e0001}",
            "\u{1d173}",
            "\u{13430}",
            "\u{0890}",
            "\u{08e2}",
            "\u{110bd}",
            "\u{1bca0}",
        ] {
            let result = html_to_markdown(&format!("<a href=\"{prefix}javascript:alert(1)\">click</a>"));
            assert!(
                !result.contains("javascript:") && result.contains("click"),
                "{prefix:?}: {result}"
            );
        }
    }

    #[test]
    fn strips_only_control_format_and_space_separator_characters() {
        assert_eq!(strip_invisible("\u{e0020}\u{200b}\u{3000}\u{7}x"), "x");
        assert_eq!(strip_invisible("\u{2028}x"), "\u{2028}x");
        assert_eq!(strip_invisible("x\u{200b}"), "x\u{200b}");
    }

    #[test]
    fn drops_vbscript_and_data_hrefs_but_keeps_link_text() {
        for href in ["vbscript:msgbox(1)", "data:text/html,<script>alert(1)</script>"] {
            assert_eq!(
                html_to_markdown(&format!("<a href=\"{href}\">click</a>")).trim(),
                "click"
            );
        }
    }

    #[test]
    fn drops_javascript_and_vbscript_img_srcs() {
        assert!(!html_to_markdown("<img src=\"javascript:alert(1)\" alt=\"x\">").contains("javascript:"));
        assert_eq!(html_to_markdown("<img src=\"vbscript:msgbox(1)\" alt=\"x\">"), "");
        for prefix in ["\u{200b}", "\u{00ad}", "\u{feff}"] {
            let result = html_to_markdown(&format!("<img src=\"{prefix}javascript:alert(1)\" alt=\"x\">"));
            assert!(!result.contains("javascript:"), "{prefix:?}: {result}");
        }
    }

    #[test]
    fn returns_alt_text_for_image_with_empty_src() {
        assert!(html_to_markdown("<img src=\"\" alt=\"description\">").contains("description"));
    }

    #[test]
    fn strips_data_uri_image_blob_with_invisible_prefix() {
        let blob = "A".repeat(100);
        let result = html_to_markdown(&format!(
            "<img src=\"\u{200b}data:image/png;base64,{blob}\" alt=\"alt\">"
        ));
        assert!(!result.contains(&blob) && result.contains("alt"), "{result}");
    }

    #[test]
    fn embeds_the_page_title_as_a_top_level_heading() {
        let result = html_to_markdown("<html><head><title>My Page</title></head><body><p>body</p></body></html>");
        assert!(result.starts_with("# My Page\n"), "{result:?}");
        assert!(result.contains("body"));
    }

    #[test]
    fn produces_no_heading_when_there_is_no_title() {
        assert!(!html_to_markdown("<p>no title here</p>").starts_with('#'));
    }
}
