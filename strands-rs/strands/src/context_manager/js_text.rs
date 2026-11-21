//! String helpers for the context manager's texts: lengths and slices count UTF-16 code units, and
//! integers print with `en-US` thousands separators.

/// A string held as UTF-16 code units, so lengths and slices count code units.
pub(crate) struct Utf16Text {
    units: Vec<u16>,
}

impl Utf16Text {
    pub(crate) fn new(text: &str) -> Self {
        Self {
            units: text.encode_utf16().collect(),
        }
    }

    pub(crate) fn len(&self) -> usize {
        self.units.len()
    }

    /// `text.slice(start, end)` with both bounds clamped to the length.
    pub(crate) fn slice(&self, start: usize, end: usize) -> String {
        let end = end.min(self.units.len());
        let start = start.min(end);
        String::from_utf16_lossy(&self.units[start..end])
    }

    /// `text.lastIndexOf(needle, from)` for a one-unit needle.
    pub(crate) fn last_index_of(&self, needle: char, from: usize) -> Option<usize> {
        let mut buffer = [0u16; 2];
        let encoded = needle.encode_utf16(&mut buffer);
        let unit = encoded[0];
        let upper = from.min(self.units.len().saturating_sub(1));
        if self.units.is_empty() {
            return None;
        }
        (0..=upper).rev().find(|&index| self.units[index] == unit)
    }
}

/// The UTF-16 length of `text` (`text.length`).
pub(crate) fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(0, end)` in UTF-16 code units.
pub(crate) fn js_prefix(text: &str, end: usize) -> String {
    Utf16Text::new(text).slice(0, end)
}

/// Formats an integer with `,` thousands separators (`toLocaleString('en-US')`).
pub(crate) fn with_separators(value: u64) -> String {
    let digits = value.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_and_slices_utf16_code_units() {
        let text = Utf16Text::new("a\u{1F600}b");
        assert_eq!(text.len(), 4);
        assert_eq!(text.slice(0, 3), "a\u{1F600}");
        assert_eq!(text.slice(3, 10), "b");
        assert_eq!(js_len("héllo"), 5);
    }

    #[test]
    fn finds_the_last_newline_at_or_before_an_index() {
        let text = Utf16Text::new("ab\ncd\nef");
        assert_eq!(text.last_index_of('\n', 4), Some(2));
        assert_eq!(text.last_index_of('\n', 5), Some(5));
        assert_eq!(text.last_index_of('\n', 1), None);
        assert_eq!(text.last_index_of('\n', 100), Some(5));
    }

    #[test]
    fn formats_integers_with_en_us_separators() {
        assert_eq!(with_separators(0), "0");
        assert_eq!(with_separators(999), "999");
        assert_eq!(with_separators(1_000), "1,000");
        assert_eq!(with_separators(999_600), "999,600");
        assert_eq!(with_separators(1_234_567), "1,234,567");
    }
}
