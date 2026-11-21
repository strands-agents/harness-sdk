//! Checks every harness tool's spec against the shared cross-SDK fixture
//! `strands-rs/conformance/fixtures/harness_tools.json` byte for byte.

use std::sync::Arc;

use strands::Tool;
use strands::types::JsonValue;

use super::file_tools::{edit_tool, read_tool, write_tool};
use super::programmatic_tool_caller::{
    MakeProgrammaticToolCallerOptions, ProgrammaticToolCallerConfig, make_programmatic_tool_caller,
    programmatic_tool_caller,
};
use super::web_fetch::{WebFetchConfig, web_fetch_tool};
use super::web_search::{SearchBackend, SearchResult, WebSearchError, search_tool};
use crate::factory::{BUILTIN_TOOL_FACTORY, SubagentToolOptions};

fn fixtures() -> Vec<(String, String)> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../strands-rs/conformance/fixtures/harness_tools.json"
    );
    let fixture: JsonValue = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    fixture["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|case| {
            (
                case["name"].as_str().unwrap().to_owned(),
                case["json"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

struct NoBackend;

#[async_trait::async_trait]
impl SearchBackend for NoBackend {
    async fn search(&self, _query: &str, _max_results: usize) -> Result<Vec<SearchResult>, WebSearchError> {
        Ok(Vec::new())
    }
}

/// The harness `subagent` over the selectable set `builtinTools: ['shell', 'read', 'subagent']` yields.
fn default_harness_subagent() -> Arc<dyn Tool> {
    let options = SubagentToolOptions {
        builder: Arc::new(|_spec| Box::pin(async { Err(strands::Error::other("unused")) })),
        inherited_tools: vec!["shell".to_owned(), "read".to_owned(), "subagent".to_owned()],
        max_depth: None,
    };
    (BUILTIN_TOOL_FACTORY.subagent)(options).unwrap()
}

fn tool(name: &str) -> Arc<dyn Tool> {
    match name {
        "read" => Arc::new(read_tool(true)),
        "read_media_off" => Arc::new(read_tool(false)),
        "write" => Arc::new(write_tool()),
        "edit" => Arc::new(edit_tool()),
        "web_fetch" => Arc::new(web_fetch_tool(WebFetchConfig::default(), None).unwrap()),
        "web_search" => Arc::new(search_tool(Arc::new(NoBackend))),
        "programmatic_tool_caller" => Arc::new(programmatic_tool_caller(ProgrammaticToolCallerConfig::default())),
        "programmatic_tool_caller_named" => Arc::new(make_programmatic_tool_caller(
            MakeProgrammaticToolCallerOptions::builder()
                .name("run_code".to_owned())
                .build(),
        )),
        "subagent_default_harness" => default_harness_subagent(),
        other => panic!("no Rust tool for fixture case {other}"),
    }
}

#[test]
fn harness_tool_specs_match_the_ts_fixture() {
    let cases = fixtures();
    assert_eq!(cases.len(), 9);
    for (name, json) in cases {
        let spec = serde_json::to_string(&tool(&name).tool_spec()).unwrap();
        assert_eq!(spec, json, "{name}");
    }
}
