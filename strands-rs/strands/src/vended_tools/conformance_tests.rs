//! Checks every vended tool's spec against the shared `conformance/fixtures/vended_tools.json` byte
//! for byte.

use crate::multiagent::{Choice, ChoiceOption, Fixed, Preset};
use crate::tools::Tool;
use crate::types::JsonValue;

use super::subagent::{MakeSubagentOptions, generalist, make_subagent, subagent};
use super::{
    bash, edit, file_editor, handoff_to_user, http_request, notebook, python_repl, read, shell, sleep, stop, web_fetch,
    write,
};

fn fixtures() -> Vec<(String, String)> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../conformance/fixtures/vended_tools.json");
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

#[allow(deprecated, reason = "the fileEditor spec is part of the fixture")]
fn tool(name: &str) -> Box<dyn Tool> {
    match name {
        "shell" => Box::new(shell::make_shell(shell::MakeShellOptions::default()).unwrap()),
        "shell_default_timeout_300" => {
            Box::new(shell::make_shell(shell::MakeShellOptions::builder().default_timeout(300.0).build()).unwrap())
        }
        "read" => Box::new(read::read()),
        "read_media_off" => Box::new(read::make_read(read::MakeReadOptions::builder().media(false).build())),
        "write" => Box::new(write::write()),
        "edit" => Box::new(edit::edit()),
        "file_editor" => Box::new(file_editor::file_editor()),
        "bash" => Box::new(bash::bash()),
        "python_repl" => Box::new(python_repl::python_repl()),
        "notebook" => Box::new(notebook::notebook()),
        "http_request" => Box::new(http_request::http_request()),
        "sleep" => Box::new(sleep::sleep()),
        "sleep_max_duration_2_5" => {
            Box::new(sleep::make_sleep(sleep::MakeSleepOptions::builder().max_duration(2.5).build()).unwrap())
        }
        "stop" => Box::new(stop::stop()),
        "stop_max_message_length_100" => {
            Box::new(stop::make_stop(stop::MakeStopOptions::builder().max_message_length(100).build()).unwrap())
        }
        "handoff_to_user" => Box::new(handoff_to_user::handoff_to_user()),
        "web_fetch" => Box::new(web_fetch::web_fetch()),
        "web_fetch_markdown" => Box::new(
            web_fetch::make_web_fetch(
                web_fetch::MakeWebFetchOptions::builder()
                    .mode(web_fetch::WebFetchMode::Markdown)
                    .build(),
            )
            .unwrap(),
        ),
        "subagent" => Box::new(subagent()),
        "subagent_choice_axes" => Box::new(
            make_subagent(MakeSubagentOptions {
                presets: Some(vec![
                    ("generalist".to_owned(), generalist()),
                    (
                        "reviewer".to_owned(),
                        Preset::builder()
                            .instructions("review")
                            .tools(["read"])
                            .model("small")
                            .description("reviews diffs")
                            .build(),
                    ),
                ]),
                instructions: Some(Fixed::none().into()),
                tools: Some(
                    Choice::new([
                        ChoiceOption::new("readonly")
                            .with_value("read")
                            .with_description("read files"),
                        "shell".into(),
                    ])
                    .multiple(true)
                    .into(),
                ),
                model: Some(Choice::new(["fast", "deep"]).into()),
                context: Some(
                    Choice::new([
                        ChoiceOption::new("none").with_description("fresh"),
                        "all".into(),
                        "no_tools".into(),
                    ])
                    .into(),
                ),
                ..MakeSubagentOptions::default()
            })
            .unwrap(),
        ),
        other => panic!("no Rust tool for fixture case {other}"),
    }
}

#[test]
fn every_vended_tool_spec_matches_the_ts_fixture_byte_for_byte() {
    let cases = fixtures();
    assert_eq!(cases.len(), 20);
    for (name, json) in cases {
        let spec = serde_json::to_string(&tool(&name).tool_spec()).unwrap();
        // The TS description ends with a runtime note ("Node.js only.") that does not apply here.
        let expected = if name == "bash" {
            json.replacen(" Node.js only.", "", 1)
        } else {
            json
        };
        assert_eq!(spec, expected, "{name}");
    }
}
