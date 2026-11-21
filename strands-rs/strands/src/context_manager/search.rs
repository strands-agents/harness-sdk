//! Grep-like search and line-range access over offloaded text, with output capped to a character
//! budget. Lengths count UTF-16 code units.

use std::collections::BTreeSet;
use std::sync::LazyLock;

use regex::Regex;

use super::js_text::{Utf16Text, js_len, js_prefix};
use crate::error::{Error, Result};

const MAX_PATTERN_LENGTH: usize = 200;

/// Best-effort guard against catastrophic patterns such as `(a+)+`; it does not catch all of them.
static NESTED_QUANTIFIER: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"[+*]\s*\)\s*[+*]").ok());

/// A 1-indexed inclusive line span.
#[derive(Debug, Clone, Copy)]
pub(crate) struct LineRange {
    pub(crate) start: usize,
    pub(crate) end: usize,
}

/// What to search for: the input of [`search_content`].
#[derive(Debug, Clone)]
pub(crate) struct SearchInput {
    pub(crate) pattern: Option<String>,
    pub(crate) line_range: Option<LineRange>,
    pub(crate) context_lines: usize,
}

/// Cuts output at the last newline before `max_chars` and appends a truncation message.
fn truncate(output: String, max_chars: usize, message: &str) -> String {
    let text = Utf16Text::new(&output);
    if text.len() <= max_chars {
        return output;
    }
    let slice_end = match text.last_index_of('\n', max_chars) {
        Some(cut) if cut > 0 => cut,
        _ => max_chars,
    };
    format!("{}\n\n[{message}]", text.slice(0, slice_end))
}

/// Formats lines with numbers, `>` for matches and `---` between gaps.
fn format_lines(lines: &[&str], indices: &[usize], matched: &BTreeSet<usize>) -> String {
    let Some(&last) = indices.last() else {
        return String::new();
    };
    let pad_width = (last + 1).to_string().len();
    let mut output = Vec::with_capacity(indices.len());
    for (position, &index) in indices.iter().enumerate() {
        if position > 0 && index > indices[position - 1] + 1 {
            output.push("---".to_owned());
        }
        let prefix = if matched.contains(&index) { '>' } else { ' ' };
        output.push(format!("{prefix} {:>pad_width$}| {}", index + 1, lines[index]));
    }
    output.join("\n")
}

fn compile(pattern: &str) -> Option<Regex> {
    let nested = NESTED_QUANTIFIER.as_ref().is_none_or(|guard| guard.is_match(pattern));
    if !nested && let Ok(regex) = Regex::new(pattern) {
        return Some(regex);
    }
    Regex::new(&regex::escape(pattern)).ok()
}

fn safe_pattern(pattern: &str) -> String {
    let replaced: String = pattern
        .chars()
        .map(|c| if matches!(c, '\n' | '\r' | '/' | ']') { ' ' } else { c })
        .collect();
    js_prefix(&replaced, 50)
}

struct Scope<'a> {
    lines: &'a [&'a str],
    start: usize,
    end: usize,
    label: String,
}

fn search_by_pattern(scope: &Scope<'_>, pattern: &str, context_lines: usize, max_chars: usize) -> String {
    let truncated = if js_len(pattern) > MAX_PATTERN_LENGTH {
        js_prefix(pattern, MAX_PATTERN_LENGTH)
    } else {
        pattern.to_owned()
    };
    let regex = compile(&truncated);
    let matched: BTreeSet<usize> = (scope.start..=scope.end)
        .filter(|&index| regex.as_ref().is_some_and(|regex| regex.is_match(scope.lines[index])))
        .collect();
    if matched.is_empty() {
        return format!(
            "No matches found for pattern '{pattern}'{} (searched {} lines).",
            scope.label,
            scope.end - scope.start + 1
        );
    }
    let visible: BTreeSet<usize> = matched
        .iter()
        .flat_map(|&index| {
            index.saturating_sub(context_lines).max(scope.start)..=(index + context_lines).min(scope.end)
        })
        .collect();
    let plural = if matched.len() > 1 { "es" } else { "" };
    let header = format!(
        "[{} match{plural} for /{}/{}]",
        matched.len(),
        safe_pattern(pattern),
        scope.label
    );
    let indices: Vec<usize> = visible.into_iter().collect();
    let body = format_lines(scope.lines, &indices, &matched);
    format!(
        "{header}\n\n{}",
        truncate(body, max_chars, "output truncated, narrow your search")
    )
}

fn search_by_line_range(lines: &[&str], start: usize, end: usize, max_chars: usize) -> String {
    let indices: Vec<usize> = (start..=end).collect();
    let header = format!("[Lines {}-{} of {}]", start + 1, end + 1, lines.len());
    let body = format_lines(lines, &indices, &BTreeSet::new());
    format!(
        "{header}\n\n{}",
        truncate(body, max_chars, "output truncated, narrow your range")
    )
}

/// Searches text by pattern or line range, capped at `max_chars`.
///
/// # Errors
///
/// A `line_range` that is inverted or starts past the end of the content. Callers are tools, which
/// turn the error into an error result; returning the message would report the failure as a
/// success.
pub(crate) fn search_content(text: &str, input: &SearchInput, max_chars: usize) -> Result<String> {
    let lines: Vec<&str> = text.split('\n').collect();
    let total_lines = lines.len();
    if total_lines == 1 && lines[0].is_empty() {
        return Ok("Content is empty (0 lines).".to_owned());
    }
    let mut scope_start = 0;
    let mut scope_end = total_lines - 1;
    if let Some(range) = input.line_range {
        if range.start > range.end {
            return Err(Error::other(format!(
                "line_range.start ({}) must be <= line_range.end ({}).",
                range.start, range.end
            )));
        }
        if range.start > total_lines {
            return Err(Error::other(format!(
                "line_range.start ({}) is beyond content length ({total_lines} lines).",
                range.start
            )));
        }
        scope_start = range.start.saturating_sub(1);
        scope_end = range.end.saturating_sub(1).min(total_lines - 1);
    }
    let Some(pattern) = input.pattern.as_deref().filter(|pattern| !pattern.is_empty()) else {
        return Ok(search_by_line_range(&lines, scope_start, scope_end, max_chars));
    };
    let label = input
        .line_range
        .map(|range| format!(" in lines {}-{}", range.start, scope_end + 1))
        .unwrap_or_default();
    let scope = Scope {
        lines: &lines,
        start: scope_start,
        end: scope_end,
        label,
    };
    Ok(search_by_pattern(&scope, pattern, input.context_lines, max_chars))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(pattern: Option<&str>, line_range: Option<(usize, usize)>) -> SearchInput {
        SearchInput {
            pattern: pattern.map(str::to_owned),
            line_range: line_range.map(|(start, end)| LineRange { start, end }),
            context_lines: 1,
        }
    }

    #[test]
    fn marks_matches_and_separates_gaps() {
        let text = "a\nERROR one\nb\nc\nd\nERROR two\ne";
        assert_eq!(
            search_content(text, &input(Some("ERROR"), None), 10_000).unwrap(),
            "[2 matches for /ERROR/]\n\n  1| a\n> 2| ERROR one\n  3| b\n---\n  5| d\n> 6| ERROR two\n  7| e"
        );
    }

    #[test]
    fn reports_no_matches_with_the_scope() {
        assert_eq!(
            search_content("a\nb\nc", &input(Some("zzz"), Some((2, 3))), 10_000).unwrap(),
            "No matches found for pattern 'zzz' in lines 2-3 (searched 2 lines)."
        );
    }

    #[test]
    fn falls_back_to_a_literal_for_an_invalid_or_nested_pattern() {
        assert!(
            search_content("a(b\nc", &input(Some("a(b"), None), 10_000)
                .unwrap()
                .starts_with("[1 match for /a(b/]")
        );
        assert!(
            search_content("(a+)+", &input(Some("(a+)+"), None), 10_000)
                .unwrap()
                .starts_with("[1 match")
        );
    }

    #[test]
    fn validates_line_ranges() {
        assert_eq!(
            search_content("a\nb", &input(None, Some((3, 2))), 100)
                .unwrap_err()
                .to_string(),
            "line_range.start (3) must be <= line_range.end (2)."
        );
        assert_eq!(
            search_content("a\nb", &input(None, Some((5, 9))), 100)
                .unwrap_err()
                .to_string(),
            "line_range.start (5) is beyond content length (2 lines)."
        );
        assert_eq!(
            search_content("", &input(None, None), 100).unwrap(),
            "Content is empty (0 lines)."
        );
    }

    #[test]
    fn truncates_at_a_line_boundary() {
        let text = (1..=20)
            .map(|index| format!("line {index}"))
            .collect::<Vec<_>>()
            .join("\n");
        let output = search_content(&text, &input(None, Some((1, 20))), 30).unwrap();
        assert!(output.ends_with("\n\n[output truncated, narrow your range]"));
        assert!(output.starts_with("[Lines 1-20 of 20]\n\n   1| line 1\n   2| line 2"));
    }
}
