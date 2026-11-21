//! HTML to markdown for the web fetch tool, on `htmd` (a turndown port) with these options and
//! rules: ATX headings, fenced code, `-` bullets, inline links; non-content elements dropped; the
//! `<title>` as a top-level heading; `data:` images reduced to their alt text; images with a
//! `javascript:` or `vbscript:` source dropped, and links with a `javascript:`, `vbscript:` or
//! `data:` href reduced to their text.

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

/// The whitespace, control, format and separator characters (`\p{Cc}\p{Cf}\p{Zs}\p{Zl}\p{Zp}`)
/// before a URL, from the Unicode tables of the `regex` crate.
static INVISIBLE_PREFIX: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"^[\p{Cc}\p{Cf}\p{Zs}\p{Zl}\p{Zp}]+").ok());

static SCHEME: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"^([a-zA-Z][a-zA-Z0-9+.-]*):").ok());

/// The lowercased scheme of `url`, or empty: read after the invisible characters before it, with
/// tab, CR and LF removed anywhere as browsers do. The rest of the URL is not parsed, so a
/// malformed host does not hide the scheme.
fn url_scheme(url: &str) -> String {
    let start = INVISIBLE_PREFIX
        .as_ref()
        .and_then(|pattern| pattern.find(url))
        .map_or(0, |prefix| prefix.end());
    let stripped: String = url
        .get(start..)
        .unwrap_or(url)
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect();
    SCHEME
        .as_ref()
        .and_then(|pattern| pattern.captures(&stripped))
        .and_then(|captures| captures.get(1))
        .map(|scheme| scheme.as_str().to_ascii_lowercase())
        .unwrap_or_default()
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
    match url_scheme(src).as_str() {
        "javascript" | "vbscript" => Some("".into()),
        "data" => Some(alt.into()),
        _ => Some(format!("![{alt}]({src})").into()),
    }
}

fn safe_link(handlers: &dyn Handlers, element: Element<'_>) -> Option<HandlerResult> {
    let href = attribute(&element, "href").unwrap_or_default();
    if matches!(url_scheme(&href).as_str(), "javascript" | "vbscript" | "data") {
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
    fn reads_the_scheme_after_invisible_characters_without_parsing_the_url() {
        assert_eq!(
            url_scheme("\u{e0020}\u{200b}\u{3000}\u{7}\u{2028}JavaScript:x"),
            "javascript"
        );
        assert_eq!(url_scheme("ja\nva\tscr\ript:x"), "javascript");
        assert_eq!(url_scheme("x\u{200b}:y"), "");
        assert_eq!(url_scheme("/relative:path"), "");
        assert_eq!(url_scheme("http://[bad"), "http");
    }

    #[test]
    fn drops_hrefs_and_img_srcs_with_a_line_separator_prefix() {
        for prefix in ["\u{2028}", "\u{2029}", "\u{200b}\u{2028} "] {
            for url in ["javascript:alert(1)", "vbscript:msgbox(1)", "data:text/html,x"] {
                assert_eq!(
                    html_to_markdown(&format!("<a href=\"{prefix}{url}\">click</a>")),
                    "click\n",
                    "{prefix:?} {url}"
                );
            }
            for (src, expected) in [
                ("javascript:alert(1)", ""),
                ("vbscript:msgbox(1)", ""),
                ("data:image/png;base64,AAAA", "x\n"),
            ] {
                assert_eq!(
                    html_to_markdown(&format!("<img src=\"{prefix}{src}\" alt=\"x\">")),
                    expected,
                    "{prefix:?} {src}"
                );
            }
        }
    }

    #[test]
    fn drops_javascript_href_with_a_format_character_prefix() {
        for code_point in [
            0x0890, 0x0891, 0x13439, 0x1343A, 0x1343B, 0x1343C, 0x1343D, 0x1343E, 0x1343F,
        ] {
            let prefix = char::from_u32(code_point).unwrap();
            assert_eq!(
                html_to_markdown(&format!("<a href=\"{prefix}javascript:alert(1)\">click</a>")),
                "click\n",
                "U+{code_point:04X}"
            );
        }
    }

    #[test]
    fn drops_javascript_hrefs_with_a_tab_inside_the_scheme() {
        assert_eq!(
            html_to_markdown("<a href=\"java\tscript:alert(1)\">click</a>"),
            "click\n"
        );
    }

    #[test]
    fn drops_hrefs_with_an_unparseable_host() {
        for url in [
            "javascript://\u{2100}%0aalert(1)",
            "vbscript://[x",
            "data://[x/text/html,x",
        ] {
            assert_eq!(
                html_to_markdown(&format!("<a href=\"{url}\">click</a>")),
                "click\n",
                "{url}"
            );
        }
    }

    #[test]
    fn keeps_an_unparseable_href_and_converts_the_rest_of_the_page() {
        let html = "<h1>Hi</h1><a href=\"javascript:alert(1)\">js</a> <a href=\"http://[bad\">bad</a>";
        assert_eq!(html_to_markdown(html), "# Hi\n\njs [bad](http://[bad)\n");
    }

    #[test]
    fn keeps_an_unparseable_img_src() {
        assert_eq!(
            html_to_markdown("<img src=\"http://[bad\" alt=\"pic\">"),
            "![pic](http://[bad)\n"
        );
    }

    #[test]
    fn drops_vbscript_and_data_hrefs_but_keeps_link_text() {
        for href in ["VBScript:msgbox(1)", "data:text/html,<script>alert(1)</script>"] {
            assert_eq!(
                html_to_markdown(&format!("<a href=\"{href}\">click</a>")).trim(),
                "click"
            );
        }
    }

    #[test]
    fn drops_javascript_and_vbscript_img_srcs() {
        assert!(!html_to_markdown("<img src=\"javascript:alert(1)\" alt=\"x\">").contains("javascript:"));
        assert_eq!(html_to_markdown("<img src=\"VBScript:msgbox(1)\" alt=\"x\">"), "");
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
