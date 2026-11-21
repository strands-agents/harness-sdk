//! The typed options make untyped input (a non-boolean `*`, a config object on `write`, unknown
//! names in a mapping) a compile error; its JSON form is checked by the portable config tests.

use super::*;
use crate::test_support::record_logs;

fn enabled_names(value: Option<&BuiltinToolsOption>) -> Vec<BuiltinToolName> {
    resolve_builtin_tools(value).enabled()
}

mod resolve_builtin_tools {
    use super::*;

    #[test]
    fn selects_the_defaults_when_undefined() {
        assert_eq!(enabled_names(None), DEFAULT_BUILTIN_TOOLS);
    }

    #[test]
    fn pins_a_list_exactly() {
        let option = BuiltinToolsOption::from([BuiltinToolName::Read, BuiltinToolName::Shell]);
        let resolved = resolve_builtin_tools(Some(&option));
        assert_eq!(resolved.enabled(), [BuiltinToolName::Shell, BuiltinToolName::Read]);
        assert!(!resolved.web_fetch.is_enabled());
        assert!(!resolved.subagent.is_enabled());
    }

    #[test]
    fn resolves_every_built_in_name_in_the_record() {
        let resolved = resolve_builtin_tools(Some(&BuiltinToolsOption::List(Vec::new())));
        assert!(resolved.enabled().is_empty());
        let config = resolved.to_config();
        assert!(config.shell.is_some() && config.read.is_some() && config.write.is_some() && config.edit.is_some());
        assert!(config.web_fetch.is_some() && config.web_search.is_some());
        assert!(config.programmatic_tool_caller.is_some() && config.subagent.is_some());
    }

    #[test]
    fn edits_the_defaults_with_a_mapping() {
        let option = BuiltinToolsConfig::builder()
            .subagent(false)
            .web_search(true)
            .build()
            .into();
        let resolved = resolve_builtin_tools(Some(&option));
        assert!(!resolved.subagent.is_enabled());
        assert_eq!(resolved.web_search, WebSearchSetting::On);
        assert!(resolved.shell.is_enabled());
        assert!(resolved.read.is_enabled());
    }

    #[test]
    fn starts_from_nothing_when_star_is_false() {
        let option = BuiltinToolsConfig::builder().all(false).read(true).build().into();
        assert_eq!(enabled_names(Some(&option)), [BuiltinToolName::Read]);
    }

    #[test]
    fn treats_star_true_as_the_defaults() {
        let option = BuiltinToolsConfig::builder().all(true).build().into();
        assert_eq!(enabled_names(Some(&option)), enabled_names(None));
    }

    #[test]
    fn keeps_a_per_tool_web_fetch_config() {
        let web_fetch = WebFetchConfig::builder()
            .model("openai/gpt-5-mini")
            .transport(crate::WebFetchTransport::Direct)
            .build();
        let option = BuiltinToolsConfig::builder().web_fetch(web_fetch).build().into();
        let config = resolve_builtin_tools(Some(&option)).web_fetch_config().unwrap();
        assert!(matches!(config.model, Some(ModelSource::Id(model)) if model == "openai/gpt-5-mini"));
        assert_eq!(config.transport, Some(crate::WebFetchTransport::Direct));
    }

    #[test]
    fn reports_an_empty_web_fetch_config_when_enabled_without_one_and_none_when_off() {
        let config = resolve_builtin_tools(None).web_fetch_config().unwrap();
        assert!(config.model.is_none() && config.transport.is_none());
        let off = BuiltinToolsConfig::builder().web_fetch(false).build().into();
        assert!(resolve_builtin_tools(Some(&off)).web_fetch_config().is_none());
    }

    #[test]
    fn rejects_an_unknown_name_in_a_list() {
        let error = "grep".parse::<BuiltinToolName>().unwrap_err();
        assert!(error.to_string().starts_with("Unknown built-in tool \"grep\""));
    }

    #[test]
    fn keeps_a_per_tool_config() {
        let shell = ShellConfig::builder()
            .description("Run a command in the sandbox.")
            .build();
        let option = BuiltinToolsConfig::builder().shell(shell.clone()).build().into();
        assert_eq!(resolve_builtin_tools(Some(&option)).shell_config(), Some(shell));
        let caller = ProgrammaticToolCallerConfig {
            allowed_tools: Some(vec!["read".to_owned()]),
            timeout: Some(Some(60.0)),
        };
        let option = BuiltinToolsConfig::builder()
            .programmatic_tool_caller(caller.clone())
            .build()
            .into();
        assert_eq!(
            resolve_builtin_tools(Some(&option)).programmatic_tool_caller_config(),
            Some(caller)
        );
        let subagent = SubagentConfig { max_depth: Some(1) };
        let option = BuiltinToolsConfig::builder().subagent(subagent).build().into();
        assert_eq!(resolve_builtin_tools(Some(&option)).subagent_config(), Some(subagent));
        let on = BuiltinToolsConfig::builder().subagent(true).build().into();
        assert_eq!(
            resolve_builtin_tools(Some(&on)).subagent_config(),
            Some(SubagentConfig::default())
        );
        let off = BuiltinToolsConfig::builder().subagent(false).build().into();
        assert_eq!(resolve_builtin_tools(Some(&off)).subagent_config(), None);
    }

    #[test]
    fn accepts_exa_for_web_search() {
        let option = BuiltinToolsConfig::builder()
            .web_search(WebSearchSetting::Exa)
            .build()
            .into();
        assert_eq!(resolve_builtin_tools(Some(&option)).web_search, WebSearchSetting::Exa);
    }
}

mod web_search_explicit {
    use super::*;

    #[test]
    fn is_false_for_the_defaults() {
        assert!(!web_search_explicit(None));
    }

    #[test]
    fn is_true_when_named_in_a_list_or_as_a_mapping_key() {
        let list = BuiltinToolsOption::from([BuiltinToolName::Read, BuiltinToolName::WebSearch]);
        assert!(web_search_explicit(Some(&list)));
        for setting in [WebSearchSetting::On, WebSearchSetting::Off, WebSearchSetting::Exa] {
            let mapping = BuiltinToolsConfig::builder().web_search(setting).build().into();
            assert!(web_search_explicit(Some(&mapping)));
        }
    }

    #[test]
    fn is_false_when_a_mapping_leaves_it_alone() {
        let mapping = BuiltinToolsConfig::builder().read(true).build().into();
        assert!(!web_search_explicit(Some(&mapping)));
    }
}

mod web_search_mode {
    use super::*;

    #[test]
    fn logs_info_not_a_warning_when_default_web_search_hits_the_default_bedrock_model() {
        let (logs, _guard) = record_logs();
        assert_eq!(web_search_mode(true.into(), false, None).unwrap(), None);
        let info = logs.lines("INFO");
        assert!(
            info.iter()
                .any(|line| line.contains("has no built-in web search") && line.contains("web-access/#web_search"))
        );
        assert!(logs.lines("WARN").is_empty());
    }

    #[test]
    fn throws_when_web_search_is_explicitly_selected_on_an_unsupported_provider() {
        let error = web_search_mode(true.into(), true, None).unwrap_err();
        assert_eq!(
            error.to_string(),
            "Model bedrock/global.anthropic.claude-opus-5-5 has no built-in web search. Pass builtinTools: { web_search: 'exa' } to search through Exa (a third party), or remove 'web_search' from builtinTools. See https://strandsagents.com/docs/user-guide/harness/tools/web-access/#web_search"
        );
    }

    #[test]
    fn warns_about_the_third_party_for_exa() {
        let (logs, _guard) = record_logs();
        assert_eq!(
            web_search_mode(WebSearchSetting::Exa, true, None).unwrap(),
            Some(WebSearchMode::Exa)
        );
        assert!(
            logs.lines("WARN")
                .iter()
                .any(|line| line.contains("Exa (exa.ai), a third-party service"))
        );
        assert!(!logs.text().contains("has no built-in web search"));
    }

    #[test]
    fn lets_an_explicit_exa_selection_win_over_native_search() {
        let model: ModelSource = "openai/gpt-5.6-sol".into();
        assert_eq!(
            web_search_mode(WebSearchSetting::Exa, true, Some(&model)).unwrap(),
            Some(WebSearchMode::Exa)
        );
        assert_eq!(
            web_search_mode(true.into(), false, Some(&model)).unwrap(),
            Some(WebSearchMode::Native)
        );
    }

    #[test]
    fn names_a_pre_built_model_instance() {
        let model: ModelSource = strands::testing::MockModel::new().into();
        let error = web_search_mode(true.into(), true, Some(&model)).unwrap_err();
        assert!(
            error
                .to_string()
                .starts_with("A pre-built Model instance has no built-in web search.")
        );
    }
}
