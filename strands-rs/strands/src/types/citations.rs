//! Citation content blocks.
//!
//! Models return citations when document citations are enabled. They are output-only blocks that
//! appear in conversation history.

use serde::{Deserialize, Serialize};

/// Where a citation points (`CitationLocation`), tagged by `type` on the wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
#[non_exhaustive]
pub enum CitationLocation {
    /// Character positions within a document, `"documentChar"`.
    DocumentChar(DocumentCharLocation),
    /// Page positions within a document, `"documentPage"`.
    DocumentPage(DocumentPageLocation),
    /// Chunk positions within a document, `"documentChunk"`.
    DocumentChunk(DocumentChunkLocation),
    /// Positions within a search result, `"searchResult"`.
    SearchResult(SearchResultLocation),
    /// A web page, `"web"`.
    Web(WebLocation),
}

macro_rules! document_location {
    ($(#[$doc:meta])* $name:ident, $variant:ident, $unit:literal) => {
        $(#[$doc])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase")]
        #[non_exhaustive]
        pub struct $name {
            /// Index of the source document.
            pub document_index: u64,
            #[doc = concat!("Start ", $unit, ".")]
            pub start: u64,
            #[doc = concat!("End ", $unit, ".")]
            pub end: u64,
        }

        impl $name {
            /// Creates the location.
            pub fn new(document_index: u64, start: u64, end: u64) -> Self {
                Self { document_index, start, end }
            }
        }

        impl From<$name> for CitationLocation {
            fn from(location: $name) -> Self {
                Self::$variant(location)
            }
        }
    };
}

document_location!(
    /// Character positions within a document.
    DocumentCharLocation,
    DocumentChar,
    "character position"
);

document_location!(
    /// Page positions within a document.
    DocumentPageLocation,
    DocumentPage,
    "page number"
);

document_location!(
    /// Chunk positions within a document.
    DocumentChunkLocation,
    DocumentChunk,
    "chunk index"
);

/// Positions within a search result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SearchResultLocation {
    /// Index of the search result.
    pub search_result_index: u64,
    /// Start position within the search result.
    pub start: u64,
    /// End position within the search result.
    pub end: u64,
}

impl SearchResultLocation {
    /// Creates the location.
    pub fn new(search_result_index: u64, start: u64, end: u64) -> Self {
        Self {
            search_result_index,
            start,
            end,
        }
    }
}

impl From<SearchResultLocation> for CitationLocation {
    fn from(location: SearchResultLocation) -> Self {
        Self::SearchResult(location)
    }
}

/// A web page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct WebLocation {
    /// The URL of the web source.
    pub url: String,
    /// The domain of the web source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
}

impl WebLocation {
    /// Creates the location from a URL.
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            domain: None,
        }
    }

    /// Sets the domain.
    #[must_use]
    pub fn with_domain(mut self, domain: impl Into<String>) -> Self {
        self.domain = Some(domain.into());
        self
    }
}

impl From<WebLocation> for CitationLocation {
    fn from(location: WebLocation) -> Self {
        Self::Web(location)
    }
}

/// Source content referenced by a citation (`CitationSourceContent`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct CitationSourceContent {
    /// The cited source text.
    pub text: String,
}

impl CitationSourceContent {
    /// Creates source content from text.
    pub fn new(text: impl Into<String>) -> Self {
        Self { text: text.into() }
    }
}

/// Generated content associated with a citation (`CitationGeneratedContent`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct CitationGeneratedContent {
    /// The generated text.
    pub text: String,
}

impl CitationGeneratedContent {
    /// Creates generated content from text.
    pub fn new(text: impl Into<String>) -> Self {
        Self { text: text.into() }
    }
}

/// A citation linking generated content to a source location (`Citation`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct Citation {
    /// The location of the cited source.
    pub location: CitationLocation,
    /// The source identifier.
    pub source: String,
    /// The source content referenced by this citation.
    pub source_content: Vec<CitationSourceContent>,
    /// Title of the cited source.
    pub title: String,
}

impl Citation {
    /// Creates a citation.
    pub fn new(
        location: impl Into<CitationLocation>,
        source: impl Into<String>,
        source_content: Vec<CitationSourceContent>,
        title: impl Into<String>,
    ) -> Self {
        Self {
            location: location.into(),
            source: source.into(),
            source_content,
            title: title.into(),
        }
    }
}

/// Citations content block (`CitationsBlock`), wrapped as `{"citations": {...}}` in a message.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct CitationsBlock {
    /// Citations linking generated content to source locations.
    pub citations: Vec<Citation>,
    /// The generated content associated with these citations.
    pub content: Vec<CitationGeneratedContent>,
}

impl CitationsBlock {
    /// Creates a citations block.
    pub fn new(citations: Vec<Citation>, content: Vec<CitationGeneratedContent>) -> Self {
        Self { citations, content }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::types::ContentBlock;

    fn single_citation() -> CitationsBlock {
        CitationsBlock::new(
            vec![Citation::new(
                DocumentCharLocation::new(0, 10, 50),
                "doc-0",
                vec![CitationSourceContent::new("source text from document")],
                "Test Document",
            )],
            vec![CitationGeneratedContent::new("generated text with citation")],
        )
    }

    fn all_variants() -> serde_json::Value {
        json!({
            "citations": {
                "citations": [
                    {"location": {"type": "documentChar", "documentIndex": 0, "start": 150, "end": 300}, "source": "doc-0", "sourceContent": [{"text": "char source"}], "title": "Text Document"},
                    {"location": {"type": "documentPage", "documentIndex": 0, "start": 2, "end": 3}, "source": "doc-0", "sourceContent": [{"text": "page source"}], "title": "PDF Document"},
                    {"location": {"type": "documentChunk", "documentIndex": 1, "start": 5, "end": 8}, "source": "doc-1", "sourceContent": [{"text": "chunk source"}], "title": "Chunked Document"},
                    {"location": {"type": "searchResult", "searchResultIndex": 0, "start": 25, "end": 150}, "source": "search-0", "sourceContent": [{"text": "search source"}], "title": "Search Result"},
                    {"location": {"type": "web", "url": "https://example.com/doc", "domain": "example.com"}, "source": "web-0", "sourceContent": [{"text": "web source"}, {"text": "additional source"}], "title": "Web Page"}
                ],
                "content": [{"text": "first generated"}, {"text": "second generated"}]
            }
        })
    }

    #[test]
    fn creates_block_with_correct_type_discriminator() {
        let block = ContentBlock::Citations(single_citation());
        assert!(matches!(block, ContentBlock::Citations(_)));
    }

    #[test]
    fn stores_citations_and_content() {
        let block = single_citation();
        assert_eq!(block.citations.len(), 1);
        assert_eq!(block.citations[0].title, "Test Document");
        assert_eq!(
            block.content,
            vec![CitationGeneratedContent::new("generated text with citation")]
        );
    }

    #[test]
    fn round_trips_all_citation_location_variants_multiple_citations_and_multiple_content_blocks() {
        let original = all_variants();
        let block: ContentBlock = serde_json::from_value(original.clone()).unwrap();
        let ContentBlock::Citations(citations) = &block else {
            panic!("expected a citations block");
        };
        assert_eq!(citations.citations.len(), 5);
        assert_eq!(
            citations.citations[4].location,
            CitationLocation::Web(WebLocation::new("https://example.com/doc").with_domain("example.com"))
        );
        assert_eq!(serde_json::to_value(&block).unwrap(), original);
    }

    #[test]
    fn handles_empty_arrays() {
        let block = ContentBlock::Citations(CitationsBlock::default());
        let json = serde_json::to_value(&block).unwrap();
        assert_eq!(json, json!({"citations": {"citations": [], "content": []}}));
        assert_eq!(serde_json::from_value::<ContentBlock>(json).unwrap(), block);
    }

    #[test]
    fn to_json_returns_wrapped_format() {
        assert_eq!(
            serde_json::to_value(ContentBlock::Citations(single_citation())).unwrap(),
            json!({
                "citations": {
                    "citations": [{
                        "location": {"type": "documentChar", "documentIndex": 0, "start": 10, "end": 50},
                        "source": "doc-0",
                        "sourceContent": [{"text": "source text from document"}],
                        "title": "Test Document"
                    }],
                    "content": [{"text": "generated text with citation"}]
                }
            })
        );
    }

    #[test]
    fn works_with_json_stringify() {
        let text = serde_json::to_string(&all_variants()).unwrap();
        let block: ContentBlock = serde_json::from_str(&text).unwrap();
        assert_eq!(serde_json::to_string(&block).unwrap(), text);
    }
}
