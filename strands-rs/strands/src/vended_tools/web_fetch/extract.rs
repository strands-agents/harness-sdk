//! HTML to markdown for the web fetch tool, on `htmd` (a turndown port) with these options and
//! rules: ATX headings, fenced code, `-` bullets, inline links; non-content elements dropped; the
//! `<title>` as a top-level heading; `data:` images reduced to their alt text; images with a
//! `javascript:` or `vbscript:` source dropped, and links with a `javascript:`, `vbscript:` or
//! `data:` href reduced to their text. Image alt text and sources are escaped so they cannot
//! change the structure of the output.

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

/// JavaScript's `\s` (which, unlike the `regex` crate's, includes U+FEFF) and `\p{Cc}`.
const JS_SPACE_OR_CONTROL: &str =
    r"[\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}\p{Cc}]";

static SPACE_RUN: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(&format!("{JS_SPACE_OR_CONTROL}+")).ok());
static SPACE_OR_SYNTAX: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(&format!(r#"{JS_SPACE_OR_CONTROL}|[<>\\"`]"#)).ok());
static IMAGE_SPECIALS: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"[\\\[\]`~]|^\^").ok());
static OPENING_PAREN: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"(^ ?|\\\] ?)\(").ok());

fn replace_all(pattern: &LazyLock<Option<Regex>>, text: &str, replacement: &str) -> String {
    match pattern.as_ref() {
        Some(pattern) => pattern.replace_all(text, replacement).into_owned(),
        None => text.to_owned(),
    }
}

/// `value` without what URL parsers strip from both ends of a URL: C0 controls and space.
fn trim_c0_control_or_space(value: &str) -> &str {
    value.trim_matches(|c: char| c <= ' ')
}

/// Image text as plain text: whitespace and control characters collapsed, markdown and HTML
/// syntax escaped. A `(` can only open a link destination at the start of the text or after a
/// `]`, so it is escaped only there.
fn escape_image_text(text: &str) -> String {
    let text = replace_all(&SPACE_RUN, text, " ");
    let text = replace_all(&IMAGE_SPECIALS, &text, r"\$0");
    let text = replace_all(&OPENING_PAREN, &text, r"${1}\(");
    text.replace('<', "&lt;").replace('>', "&gt;")
}

/// An image source without tabs and newlines, as URL parsers drop them, and with what a markdown
/// parser could read as syntax percent-encoded.
fn escape_image_src(src: &str) -> String {
    let src: String = src.chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect();
    let mut escaped = String::with_capacity(src.len());
    for c in src.chars() {
        let syntax = SPACE_OR_SYNTAX
            .as_ref()
            .is_some_and(|pattern| pattern.is_match(c.encode_utf8(&mut [0; 4])));
        if syntax || matches!(c, '(' | ')' | '\'') {
            for byte in c.encode_utf8(&mut [0; 4]).bytes() {
                escaped.push_str(&format!("%{byte:02X}"));
            }
        } else {
            escaped.push(c);
        }
    }
    escaped
}

/// Alt text written without its image: a trailing `!` would turn a link that follows into an
/// image, so it is escaped.
fn bare_alt(alt: &str) -> String {
    let body = alt.strip_suffix(' ').unwrap_or(alt);
    match body.strip_suffix('!') {
        Some(head) => format!("{head}\\{}", &alt[head.len()..]),
        None => alt.to_owned(),
    }
}

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
    let src = trim_c0_control_or_space(&src);
    let alt = escape_image_text(&attribute(&element, "alt").unwrap_or_default());
    if src.is_empty() {
        return Some(bare_alt(&alt).into());
    }
    match url_scheme(src).as_str() {
        "javascript" | "vbscript" => Some("".into()),
        "data" => Some(bare_alt(&alt).into()),
        _ => Some(format!("![{alt}]({})", escape_image_src(src)).into()),
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

    #[test]
    fn escapes_image_alt_text_and_src() {
        let cases = [
            (
                "<img alt=\"a](https://example.com/x) [b\" src=\"pic.png\">",
                "![a\\]\\(https://example.com/x) \\[b](pic.png)",
            ),
            (
                "<img alt=\"[click](https://example.com/y)\" src=\"data:image/png;base64,AAAA\">",
                "\\[click\\]\\(https://example.com/y)",
            ),
            (
                "<img alt=\"[click](https://example.com/y)\" src=\"\">",
                "\\[click\\]\\(https://example.com/y)",
            ),
            (
                "<img alt=\"&lt;https://example.com/a&gt;\" src=\"data:image/png;base64,AAAA\">",
                "&lt;https://example.com/a&gt;",
            ),
            (
                "<img alt=\"^back\\slash\n\n`tick` ~~~\" src=\"pic.png\">",
                "![\\^back\\\\slash \\`tick\\` \\~\\~\\~](pic.png)",
            ),
            (
                "<p>Rated<img alt=\" 4 stars \" src=\"data:image/png;base64,AAAA\">by users</p>",
                "Rated 4 stars by users",
            ),
            ("<img alt=\"Logo (dark)\" src=\"pic.png\">", "![Logo (dark)](pic.png)"),
            ("<img alt=\"(dark) Logo\" src=\"pic.png\">", "![\\(dark) Logo](pic.png)"),
            (
                "<img alt=\"a] (https://example.com/x)\" src=\"pic.png\">",
                "![a\\] \\(https://example.com/x)](pic.png)",
            ),
            (
                "<p>see<img alt=\" (https://example.com/y)\" src=\"data:image/png;base64,AAAA\"></p>",
                "see \\(https://example.com/y)",
            ),
            (
                "<a href=\"https://example.com/\"><img alt=\"a] b\" src=\"pic.png\"></a>",
                "[![a\\] b](pic.png)](https://example.com/)",
            ),
            (
                "<img alt=\"x\" src=\"pic.png) [click](https://example.com/z\">",
                "![x](pic.png%29%20[click]%28https://example.com/z)",
            ),
            (
                "<img alt=\"x\" src=\" a\tb<c>d\\e\x01\x7f\u{85}.png\n\">",
                "![x](ab%3Cc%3Ed%5Ce%01%7F%C2%85.png)",
            ),
            (
                "<img alt=\"x\" src=\"p.png&quot;t&quot;&#39;u&#39;`v\">",
                "![x](p.png%22t%22%27u%27%60v)",
            ),
            (
                "<p><img alt=\"Wow!\" src=\"data:image/png;base64,AAAA\"><a href=\"https://example.com/\">link</a></p>",
                "Wow\\![link](https://example.com/)",
            ),
            (
                "<p><img alt=\"Wow!\" src=\"\"><a href=\"https://example.com/\">link</a></p>",
                "Wow\\![link](https://example.com/)",
            ),
            (
                // htmd keeps the space before the link that turndown collapses.
                "<p><span><img alt=\"Wow! \" src=\"data:image/png;base64,AAAA\"> </span><a href=\"https://example.com/\">l</a></p>",
                "Wow\\! [l](https://example.com/)",
            ),
            (
                "<p><img alt=\"Wow!\" src=\"pic.png\"><a href=\"https://example.com/\">link</a></p>",
                "![Wow!](pic.png)[link](https://example.com/)",
            ),
            (
                "<img alt=\"a\x1cb\u{85}c\u{feff}d\u{a0}e\" src=\"\x1c\u{85}p\u{2028}q.png\u{feff}\x1c\">",
                "![a b c d e](%C2%85p%E2%80%A8q.png%EF%BB%BF)",
            ),
        ];
        let mut failures = Vec::new();
        for (html, expected) in cases {
            let markdown = html_to_markdown(html);
            let actual = markdown.trim_matches(crate::models::is_js_whitespace);
            if actual != expected {
                failures.push(format!("{html}\n  expected {expected:?}\n  got      {actual:?}"));
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }
}
