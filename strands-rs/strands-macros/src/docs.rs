//! Tool descriptions from doc comments, and tool names.

use syn::{Attribute, Expr, ExprLit, Ident, Lit, LitStr, Meta};

/// The tool description: the `#[tool(description = "..")]` override, or the doc comment. The
/// registry rejects a tool without a description, so an empty one is a compile error, spanned on
/// the override or the function name.
pub(crate) fn tool_description(text: Option<&LitStr>, attrs: &[Attribute], ident: &Ident) -> syn::Result<String> {
    if let Some(text) = text {
        let value = text.value();
        if value.trim().is_empty() {
            return Err(syn::Error::new(text.span(), "the tool description must not be empty"));
        }
        return Ok(value);
    }
    let value = description(attrs);
    if value.is_empty() {
        return Err(syn::Error::new(
            ident.span(),
            "`#[tool]` needs a description for the model: add a doc comment or `#[tool(description = \"..\")]`",
        ));
    }
    Ok(value)
}

/// The tool description a doc comment gives: its text up to the first rustdoc section heading
/// (`# Errors`, `# Examples`, ...), which is written for people rather than the model.
///
/// Lines are processed as schemars processes the parameter doc comments: one leading space is
/// removed, lines are joined with `\n` (so blank lines keep paragraphs apart) and the result is
/// trimmed.
pub(crate) fn description(attrs: &[Attribute]) -> String {
    let mut lines = Vec::new();
    let mut in_code = false;
    for line in doc_lines(attrs) {
        let line = line.strip_prefix(' ').unwrap_or(&line).to_owned();
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            in_code = !in_code;
        }
        if !in_code && is_heading(trimmed) {
            break;
        }
        lines.push(line);
    }
    lines.join("\n").trim().to_owned()
}

fn doc_lines(attrs: &[Attribute]) -> Vec<String> {
    attrs
        .iter()
        .filter(|attr| attr.path().is_ident("doc"))
        .filter_map(|attr| match &attr.meta {
            Meta::NameValue(meta) => match &meta.value {
                Expr::Lit(ExprLit {
                    lit: Lit::Str(text), ..
                }) => Some(text.value()),
                _ => None,
            },
            _ => None,
        })
        .flat_map(|text| text.split('\n').map(str::to_owned).collect::<Vec<_>>())
        .collect()
}

fn is_heading(line: &str) -> bool {
    let rest = line.trim_start_matches('#');
    rest.len() < line.len() && (rest.is_empty() || rest.starts_with(' '))
}

/// Whether `name` is a tool name providers accept: 1 to 64 ASCII letters, digits, `_` and `-`
/// (`strands::tools::is_valid_tool_name`).
pub(crate) fn is_valid_tool_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// `get_weather` -> `GetWeather`.
pub(crate) fn pascal_case(name: &str) -> String {
    name.split('_')
        .map(|word| {
            let mut chars = word.chars();
            chars
                .next()
                .map(|first| first.to_uppercase().chain(chars).collect::<String>())
                .unwrap_or_default()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use syn::parse_quote;

    use super::*;

    fn attrs(item: syn::ItemFn) -> Vec<Attribute> {
        item.attrs
    }

    #[test]
    fn keeps_paragraphs_and_stops_at_the_first_section_heading() {
        let attrs = attrs(parse_quote! {
            /// Get the weather.
            /// Uses the live feed.
            ///
            /// Second paragraph.
            ///
            /// ```
            /// # hidden doctest line
            /// ```
            ///
            /// # Errors
            ///
            /// Never.
            fn f() {}
        });
        assert_eq!(
            description(&attrs),
            "Get the weather.\nUses the live feed.\n\nSecond paragraph.\n\n```\n# hidden doctest line\n```"
        );
    }

    #[test]
    fn is_empty_without_doc_comments() {
        assert_eq!(description(&attrs(parse_quote! { fn f() {} })), "");
    }

    #[test]
    fn converts_names_to_pascal_case() {
        assert_eq!(pascal_case("get_weather"), "GetWeather");
        assert_eq!(pascal_case("roll"), "Roll");
        assert_eq!(pascal_case("get_v2_data"), "GetV2Data");
        assert_eq!(pascal_case("_private_tool"), "PrivateTool");
    }

    #[test]
    fn validates_tool_names() {
        assert!(is_valid_tool_name("search-web"));
        assert!(!is_valid_tool_name("météo"));
        assert!(!is_valid_tool_name(&"a".repeat(65)));
    }
}
