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
use super::subagent::{
    AgentBuilder, Choice, ChoiceOption, MakeSubagentOptions, Preset, SubagentConfig, SubagentContext, generalist,
    make_subagent, subagent_tool,
};
use super::web_fetch::{WebFetchConfig, web_fetch_tool};
use super::web_search::{SearchBackend, SearchResult, WebSearchError, search_tool};

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

fn builder() -> AgentBuilder {
    AgentBuilder::new(|_spec| async { Err(strands::Error::other("unused")) })
}

fn tool(name: &str) -> Box<dyn Tool> {
    match name {
        "read" => Box::new(read_tool(true)),
        "read_media_off" => Box::new(read_tool(false)),
        "write" => Box::new(write_tool()),
        "edit" => Box::new(edit_tool()),
        "web_fetch" => Box::new(web_fetch_tool(WebFetchConfig::default(), None).unwrap()),
        "web_search" => Box::new(search_tool(Arc::new(NoBackend))),
        "programmatic_tool_caller" => Box::new(programmatic_tool_caller(ProgrammaticToolCallerConfig::default())),
        "programmatic_tool_caller_named" => Box::new(make_programmatic_tool_caller(
            MakeProgrammaticToolCallerOptions::builder()
                .name("run_code".to_owned())
                .build(),
        )),
        "subagent_default_harness" => Box::new(
            subagent_tool(
                SubagentConfig::default(),
                SubagentContext::new(builder())
                    .with_inherited_tools(["shell", "read"])
                    .with_inherited_mcp_servers(["docs"]),
            )
            .unwrap(),
        ),
        "subagent_bare" => Box::new(make_subagent(MakeSubagentOptions::builder().builder(builder()).build()).unwrap()),
        "subagent_choice_axes" => Box::new(
            make_subagent(
                MakeSubagentOptions::builder()
                    .builder(builder())
                    .presets([
                        ("generalist", generalist()),
                        (
                            "reviewer",
                            Preset::builder()
                                .instructions("review")
                                .tools(["read"])
                                .description("reviews diffs")
                                .build(),
                        ),
                    ])
                    .instructions(Choice::new([
                        ChoiceOption::new("poet")
                            .with_value("You are a poet.")
                            .with_description("writes verse"),
                        ChoiceOption::new("plain"),
                    ]))
                    .tools(
                        Choice::new([
                            ChoiceOption::new("readonly")
                                .with_value("read")
                                .with_description("read files"),
                            ChoiceOption::new("shell"),
                        ])
                        .multiple(true),
                    )
                    .model(Choice::new(["fast", "deep"]))
                    .context(Choice::new([
                        ChoiceOption::new("fresh")
                            .with_value("none")
                            .with_description("start over"),
                        ChoiceOption::new("all"),
                    ]))
                    .name("delegate")
                    .build(),
            )
            .unwrap(),
        ),
        other => panic!("no Rust tool for fixture case {other}"),
    }
}

#[test]
fn harness_tool_specs_match_the_ts_fixture() {
    let cases = fixtures();
    assert_eq!(cases.len(), 12);
    for (name, json) in cases {
        let spec = serde_json::to_string(&tool(&name).tool_spec()).unwrap();
        assert_eq!(spec, json, "{name}");
    }
}
