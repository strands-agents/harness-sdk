use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

use futures::StreamExt;
use serde_json::json;

use super::*;
use crate::agent::InvocationState;
use crate::test_support::{local_agent, record_logs};
use crate::tools::{Tool, ToolOutcome, ToolStreamItem};
use crate::types::{CachePointBlock, ToolResultContent, ToolUse};
use crate::vended_plugins::skills::SkillConfig;
use crate::vended_plugins::skills::skill::FetchError;

fn create_skill_dir(root: &Path, name: &str, content: &str, extra_files: &[(&str, &str)]) -> String {
    let dir = root.join(name);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("SKILL.md"), content).unwrap();
    for (path, file_content) in extra_files {
        let full = dir.join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, file_content).unwrap();
    }
    dir.to_str().unwrap().to_owned()
}

fn make_skill(name: &str) -> Skill {
    make_skill_with(name, &format!("Description of {name}"))
}

fn make_skill_with(name: &str, description: &str) -> Skill {
    Skill::new(SkillConfig {
        name: name.into(),
        description: description.into(),
        instructions: Some(format!("Instructions for {name}")),
        ..Default::default()
    })
}

fn plugin(skills: impl IntoIterator<Item = impl Into<SkillSource>>) -> AgentSkills {
    AgentSkills::new(AgentSkillsConfig::builder().skills(skills).build())
}

fn url_plugin(
    urls: &[&str],
    response: std::result::Result<&'static str, FetchError>,
) -> (AgentSkills, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let fetcher = UrlFetcher::new(move |_url| {
        counter.fetch_add(1, AtomicOrdering::SeqCst);
        let response = response.clone().map(str::to_owned);
        Box::pin(async move { response })
    });
    let config = AgentSkillsConfig::builder().skills(urls.iter().copied()).build();
    (AgentSkills::with_fetcher(config, fetcher), calls)
}

fn names(skills: &[Skill]) -> Vec<&str> {
    skills.iter().map(Skill::name).collect()
}

async fn fire_before_invocation(agent: &mut LocalAgent) {
    let hooks = agent.hooks().clone();
    let mut event = BeforeInvocationEvent::new(agent, InvocationState::new(), Vec::new());
    hooks.invoke(&mut event).await.unwrap();
}

async fn invoke_tool(plugin: &AgentSkills, agent: &LocalAgent, skill_name: &str) -> String {
    let tool = plugin.skills_tool();
    let context = ToolContext::new(
        ToolUse::new("skills", "test-id", json!({"skill_name": skill_name})),
        agent.tool_agent(),
        InvocationState::new(),
    );
    let mut stream = tool.stream(context);
    let mut text = String::new();
    while let Some(item) = stream.next().await {
        if let ToolStreamItem::Outcome(ToolOutcome::Result(result)) = item {
            for content in result.content {
                if let ToolResultContent::Text(block) = content {
                    text.push_str(&block.text);
                }
            }
        }
    }
    text
}

fn prompt_text(agent: &LocalAgent) -> String {
    match agent.system_prompt() {
        Some(SystemPrompt::Text(text)) => text.clone(),
        other => panic!("expected a string prompt, got {other:?}"),
    }
}

// constructor

#[tokio::test]
async fn resolves_skill_instances_directly() {
    let plugin = plugin([make_skill("my-skill")]);
    assert_eq!(names(&plugin.get_available_skills(None).await), ["my-skill"]);
}

#[tokio::test]
async fn resolves_a_skill_directory_path() {
    let root = tempfile::tempdir().unwrap();
    let dir = create_skill_dir(
        root.path(),
        "my-skill",
        "---\nname: my-skill\ndescription: A skill\n---\nBody.",
        &[],
    );
    let plugin = plugin([dir.clone()]);
    let mut agent = local_agent();
    plugin.init_agent(&mut agent).await.unwrap();
    let skills = plugin.get_available_skills(Some(&agent)).await;
    assert_eq!(names(&skills), ["my-skill"]);
    assert_eq!(skills[0].path(), Some(dir.as_str()));
}

#[tokio::test]
async fn resolves_a_parent_directory_with_multiple_skills() {
    let root = tempfile::tempdir().unwrap();
    create_skill_dir(
        root.path(),
        "skill-b",
        "---\nname: skill-b\ndescription: Skill B\n---\nB.",
        &[],
    );
    create_skill_dir(
        root.path(),
        "skill-a",
        "---\nname: skill-a\ndescription: Skill A\n---\nA.",
        &[],
    );
    let plugin = plugin([root.path().to_str().unwrap()]);
    let mut agent = local_agent();
    plugin.init_agent(&mut agent).await.unwrap();
    assert_eq!(
        names(&plugin.get_available_skills(Some(&agent)).await),
        ["skill-a", "skill-b"]
    );
}

#[tokio::test]
async fn handles_mixed_sources() {
    let root = tempfile::tempdir().unwrap();
    let dir = create_skill_dir(
        root.path(),
        "file-skill",
        "---\nname: file-skill\ndescription: From file\n---\nBody.",
        &[],
    );
    let plugin = plugin([SkillSource::from(make_skill("direct-skill")), SkillSource::from(dir)]);
    let mut agent = local_agent();
    plugin.init_agent(&mut agent).await.unwrap();
    assert_eq!(
        names(&plugin.get_available_skills(Some(&agent)).await),
        ["direct-skill", "file-skill"]
    );
}

#[tokio::test]
async fn warns_on_duplicate_names_and_keeps_the_last() {
    let (logs, _guard) = record_logs();
    let plugin = plugin([make_skill_with("dup", "First"), make_skill_with("dup", "Second")]);
    let skills = plugin.get_available_skills(None).await;
    assert_eq!(skills.len(), 1);
    assert_eq!(skills[0].description(), "Second");
    assert!(
        logs.text()
            .contains("name=<dup> | duplicate skill name, overwriting previous skill")
    );
}

#[tokio::test]
async fn warns_and_skips_non_existent_paths() {
    let (logs, _guard) = record_logs();
    let plugin = plugin(["/does/not/exist"]);
    assert!(plugin.get_available_skills(None).await.is_empty());
    let mut agent = local_agent();
    plugin.init_agent(&mut agent).await.unwrap();
    assert!(plugin.get_available_skills(Some(&agent)).await.is_empty());
    assert!(
        logs.text()
            .contains("path=</does/not/exist> | skill source does not exist or is not a valid path")
    );
    assert!(
        logs.text()
            .contains("no skills were loaded, the agent will have no skills available")
    );
}

#[tokio::test]
async fn gracefully_handles_a_path_with_malformed_skill_md() {
    let root = tempfile::tempdir().unwrap();
    let dir = create_skill_dir(root.path(), "bad-skill", "totally broken, no frontmatter at all", &[]);
    let (logs, _guard) = record_logs();
    let plugin = plugin([dir.clone()]);
    let mut agent = local_agent();
    plugin.init_agent(&mut agent).await.unwrap();
    assert!(plugin.get_available_skills(None).await.is_empty());
    assert!(plugin.get_available_skills(Some(&agent)).await.is_empty());
    assert!(logs.text().contains(&format!(
        "path=<{dir}> | failed to load skill: Error: SKILL.md must start with --- frontmatter delimiter"
    )));
}

#[tokio::test]
async fn loads_valid_skills_from_a_parent_dir_containing_malformed_siblings() {
    let root = tempfile::tempdir().unwrap();
    create_skill_dir(
        root.path(),
        "good-skill",
        "---\nname: good-skill\ndescription: Works\n---\nBody.",
        &[],
    );
    create_skill_dir(root.path(), "bad-skill", "no frontmatter", &[]);
    let plugin = plugin([root.path().to_str().unwrap()]);
    let mut agent = local_agent();
    plugin.init_agent(&mut agent).await.unwrap();
    assert_eq!(names(&plugin.get_available_skills(Some(&agent)).await), ["good-skill"]);
}

#[tokio::test]
async fn loads_a_direct_skill_md_file_path() {
    let root = tempfile::tempdir().unwrap();
    let dir = create_skill_dir(
        root.path(),
        "my-skill",
        "---\nname: my-skill\ndescription: A skill\n---\nBody.",
        &[],
    );
    let plugin = plugin([format!("{dir}/SKILL.md")]);
    let mut agent = local_agent();
    plugin.init_agent(&mut agent).await.unwrap();
    let skills = plugin.get_available_skills(Some(&agent)).await;
    assert_eq!(names(&skills), ["my-skill"]);
    assert_eq!(skills[0].path(), Some(dir.as_str()));
}

// plugin interface

#[test]
fn has_the_correct_name() {
    assert_eq!(plugin([make_skill("s")]).name(), "strands:agent-skills");
}

#[test]
fn returns_one_tool_named_skills_from_get_tools() {
    let tools = plugin([make_skill("s")]).get_tools();
    assert_eq!(tools.len(), 1);
    let ToolSource::Tool(tool) = &tools[0] else {
        panic!("expected one tool");
    };
    assert_eq!(tool.name(), "skills");
    assert_eq!(tool.description(), SKILLS_TOOL_DESCRIPTION);
    assert_eq!(
        tool.tool_spec().input_schema,
        Some(json!({
            "type": "object",
            "properties": {
                "skill_name": {
                    "description": "Name of the skill to activate",
                    "type": "string",
                    "minLength": 1
                }
            },
            "required": ["skill_name"],
            "additionalProperties": false
        }))
    );
}

#[tokio::test]
async fn registers_a_before_invocation_event_hook_in_init_agent() {
    let plugin = plugin([make_skill("s")]);
    let mut agent = local_agent();
    plugin.init_agent(&mut agent).await.unwrap();
    assert_eq!(agent.hooks().len(), 1);
    fire_before_invocation(&mut agent).await;
    assert!(prompt_text(&agent).contains("<available_skills>"));
}

// system prompt injection

async fn pdf_agent() -> (AgentSkills, LocalAgent) {
    let plugin = plugin([make_skill_with("pdf-skill", "Process PDFs")]);
    let mut agent = local_agent();
    plugin.init_agent(&mut agent).await.unwrap();
    (plugin, agent)
}

#[tokio::test]
async fn injects_into_undefined_system_prompt() {
    let (_plugin, mut agent) = pdf_agent().await;
    agent.set_system_prompt(None);
    fire_before_invocation(&mut agent).await;
    assert_eq!(
        prompt_text(&agent),
        "<available_skills>\n<skill>\n<name>pdf-skill</name>\n<description>Process PDFs</description>\n</skill>\n</available_skills>"
    );
}

#[tokio::test]
async fn injects_into_string_system_prompt() {
    let (_plugin, mut agent) = pdf_agent().await;
    agent.set_system_prompt(Some("You are a helpful assistant.".into()));
    fire_before_invocation(&mut agent).await;
    let prompt = prompt_text(&agent);
    assert!(prompt.starts_with("You are a helpful assistant.\n\n<available_skills>"));
    assert!(prompt.contains("pdf-skill"));
}

#[tokio::test]
async fn injects_into_system_content_block_prompt() {
    let (_plugin, mut agent) = pdf_agent().await;
    agent.set_system_prompt(Some(SystemPrompt::Blocks(vec![
        SystemContentBlock::text("You are helpful."),
        SystemContentBlock::CachePoint(CachePointBlock::new()),
    ])));
    fire_before_invocation(&mut agent).await;
    let Some(SystemPrompt::Blocks(blocks)) = agent.system_prompt() else {
        panic!("expected blocks");
    };
    assert_eq!(blocks.len(), 3);
    assert!(matches!(&blocks[0], SystemContentBlock::Text(text) if text.text == "You are helpful."));
    assert!(matches!(&blocks[1], SystemContentBlock::CachePoint(_)));
    assert!(matches!(&blocks[2], SystemContentBlock::Text(text) if text.text.contains("<available_skills>")));
}

#[tokio::test]
async fn is_idempotent_re_injection_replaces_previous_block() {
    let (_plugin, mut agent) = pdf_agent().await;
    agent.set_system_prompt(Some("Base prompt.".into()));
    fire_before_invocation(&mut agent).await;
    let first = prompt_text(&agent);
    assert_eq!(first.matches("<available_skills>").count(), 1);
    fire_before_invocation(&mut agent).await;
    let second = prompt_text(&agent);
    assert_eq!(second.matches("<available_skills>").count(), 1);
    assert_eq!(second, first);
}

#[tokio::test]
async fn is_idempotent_with_system_content_block_prompt() {
    let (_plugin, mut agent) = pdf_agent().await;
    agent.set_system_prompt(Some(SystemPrompt::Blocks(vec![SystemContentBlock::text("Base.")])));
    fire_before_invocation(&mut agent).await;
    fire_before_invocation(&mut agent).await;
    let Some(SystemPrompt::Blocks(blocks)) = agent.system_prompt() else {
        panic!("expected blocks");
    };
    let skills_blocks = blocks
        .iter()
        .filter(|block| matches!(block, SystemContentBlock::Text(text) if text.text.contains("<available_skills>")))
        .count();
    assert_eq!(skills_blocks, 1);
    assert_eq!(blocks.len(), 2);
}

#[tokio::test]
async fn preserves_external_modifications_to_system_prompt() {
    let (_plugin, mut agent) = pdf_agent().await;
    agent.set_system_prompt(Some("Original.".into()));
    fire_before_invocation(&mut agent).await;
    let modified = prompt_text(&agent).replace("Original.", "Modified.");
    agent.set_system_prompt(Some(modified.into()));
    fire_before_invocation(&mut agent).await;
    let prompt = prompt_text(&agent);
    assert!(prompt.starts_with("Modified.\n\n<available_skills>"));
    assert_eq!(prompt.matches("<available_skills>").count(), 1);
}

#[tokio::test]
async fn warns_and_re_appends_when_the_injected_block_was_removed() {
    let (_plugin, mut agent) = pdf_agent().await;
    agent.set_system_prompt(Some("Base.".into()));
    fire_before_invocation(&mut agent).await;
    agent.set_system_prompt(Some("Replaced.".into()));
    let (logs, _guard) = record_logs();
    fire_before_invocation(&mut agent).await;
    assert!(prompt_text(&agent).starts_with("Replaced.\n\n<available_skills>"));
    assert!(
        logs.text()
            .contains("unable to find previously injected skills XML in system prompt, re-appending")
    );
}

#[tokio::test]
async fn xml_escapes_special_characters_in_skill_metadata() {
    let plugin = plugin([make_skill_with(
        "test-skill",
        "Use when: user says <hello> & \"goodbye\"",
    )]);
    let mut agent = local_agent();
    plugin.init_agent(&mut agent).await.unwrap();
    fire_before_invocation(&mut agent).await;
    assert!(
        prompt_text(&agent)
            .contains("<description>Use when: user says &lt;hello&gt; &amp; &quot;goodbye&quot;</description>")
    );
}

#[tokio::test]
async fn includes_skill_location_when_path_is_set() {
    let root = tempfile::tempdir().unwrap();
    let dir = create_skill_dir(
        root.path(),
        "located-skill",
        "---\nname: located-skill\ndescription: Has a path\n---\nBody.",
        &[],
    );
    let plugin = plugin([dir.clone()]);
    let mut agent = local_agent();
    plugin.init_agent(&mut agent).await.unwrap();
    fire_before_invocation(&mut agent).await;
    assert!(prompt_text(&agent).contains(&format!("<location>{dir}/SKILL.md</location>")));
}

#[tokio::test]
async fn shows_no_skills_available_when_empty() {
    let plugin = plugin(Vec::<SkillSource>::new());
    let mut agent = local_agent();
    plugin.init_agent(&mut agent).await.unwrap();
    fire_before_invocation(&mut agent).await;
    assert_eq!(
        prompt_text(&agent),
        "<available_skills>\nNo skills are currently available.\n</available_skills>"
    );
}

#[tokio::test]
async fn injects_into_null_system_prompt() {
    let (_plugin, mut agent) = pdf_agent().await;
    fire_before_invocation(&mut agent).await;
    assert!(prompt_text(&agent).contains("<available_skills>"));
    assert!(prompt_text(&agent).contains("pdf-skill"));
}

#[tokio::test]
async fn reflects_updated_skills_after_set_available_skills() {
    let (plugin, mut agent) = pdf_agent().await;
    agent.set_system_prompt(Some("Base.".into()));
    fire_before_invocation(&mut agent).await;
    assert!(prompt_text(&agent).contains("pdf-skill"));

    plugin.set_available_skills([make_skill_with("new-skill", "A new skill")]);
    fire_before_invocation(&mut agent).await;
    let prompt = prompt_text(&agent);
    assert!(prompt.contains("new-skill"));
    assert!(!prompt.contains("pdf-skill"));
    assert!(prompt.contains("Base."));
}

#[tokio::test]
async fn lists_all_skills_when_multiple_are_available() {
    let plugin = plugin([
        make_skill_with("skill-a", "First"),
        make_skill_with("skill-b", "Second"),
        make_skill_with("skill-c", "Third"),
    ]);
    let mut agent = local_agent();
    plugin.init_agent(&mut agent).await.unwrap();
    fire_before_invocation(&mut agent).await;
    let prompt = prompt_text(&agent);
    for text in ["skill-a", "skill-b", "skill-c", "First", "Second", "Third"] {
        assert!(prompt.contains(text), "{text}");
    }
}

#[tokio::test]
async fn fails_the_invocation_when_the_state_key_holds_a_non_object() {
    let (_plugin, mut agent) = pdf_agent().await;
    agent.app_state().set("agent_skills", "oops").unwrap();
    let hooks = agent.hooks().clone();
    let mut event = BeforeInvocationEvent::new(&mut agent, InvocationState::new(), Vec::new());
    let error = hooks.invoke(&mut event).await.unwrap_err();
    assert_eq!(
        error.to_string(),
        "expected object for state key 'agent_skills', got string"
    );
}

#[tokio::test]
async fn loads_path_skills_on_the_first_invocation_of_an_agent_it_did_not_initialize() {
    let root = tempfile::tempdir().unwrap();
    let dir = create_skill_dir(
        root.path(),
        "late-skill",
        "---\nname: late-skill\ndescription: Late\n---\nBody.",
        &[],
    );
    let plugin = plugin([dir]);
    let mut first = local_agent();
    plugin.init_agent(&mut first).await.unwrap();
    plugin.set_available_skills([root.path().join("late-skill").to_str().unwrap()]);
    fire_before_invocation(&mut first).await;
    assert!(prompt_text(&first).contains("late-skill"));
}

// tool callback

async fn tool_agent_with_test_skill() -> (AgentSkills, LocalAgent) {
    let plugin = plugin([Skill::new(SkillConfig {
        name: "test-skill".into(),
        description: "A test skill".into(),
        instructions: Some("# Test\nDo the thing.".into()),
        allowed_tools: Some(vec!["bash".into()]),
        compatibility: Some("v1.0+".into()),
        ..Default::default()
    })]);
    let mut agent = local_agent();
    plugin.init_agent(&mut agent).await.unwrap();
    (plugin, agent)
}

#[tokio::test]
async fn returns_instructions_for_a_valid_skill() {
    let (plugin, agent) = tool_agent_with_test_skill().await;
    let result = invoke_tool(&plugin, &agent, "test-skill").await;
    assert_eq!(
        result,
        "# Test\nDo the thing.\n\n---\nAllowed tools: bash\nCompatibility: v1.0+"
    );
}

#[tokio::test]
async fn includes_metadata_in_the_response() {
    let (plugin, agent) = tool_agent_with_test_skill().await;
    let result = invoke_tool(&plugin, &agent, "test-skill").await;
    assert!(result.contains("Allowed tools: bash"));
    assert!(result.contains("Compatibility: v1.0+"));
}

#[tokio::test]
async fn returns_error_for_unknown_skill() {
    let (plugin, agent) = tool_agent_with_test_skill().await;
    assert_eq!(
        invoke_tool(&plugin, &agent, "nonexistent").await,
        "Skill 'nonexistent' not found. Available skills: test-skill"
    );
}

#[tokio::test]
async fn tracks_activated_skills_in_app_state() {
    let (plugin, agent) = tool_agent_with_test_skill().await;
    invoke_tool(&plugin, &agent, "test-skill").await;
    assert_eq!(plugin.get_activated_skills(&agent), ["test-skill"]);
    assert_eq!(
        agent.app_state().get_value("agent_skills"),
        Some(json!({"activatedSkills": ["test-skill"]}))
    );
}

#[tokio::test]
async fn maintains_activation_order_without_duplicates() {
    let (plugin, agent) = tool_agent_with_test_skill().await;
    plugin.set_available_skills([make_skill("skill-a"), make_skill("skill-b")]);
    invoke_tool(&plugin, &agent, "skill-a").await;
    invoke_tool(&plugin, &agent, "skill-b").await;
    invoke_tool(&plugin, &agent, "skill-a").await;
    assert_eq!(plugin.get_activated_skills(&agent), ["skill-b", "skill-a"]);
}

#[tokio::test]
async fn handles_skill_with_no_instructions() {
    let (plugin, agent) = tool_agent_with_test_skill().await;
    plugin.set_available_skills([Skill::new(SkillConfig {
        name: "empty".into(),
        description: "No instructions".into(),
        ..Default::default()
    })]);
    assert_eq!(
        invoke_tool(&plugin, &agent, "empty").await,
        "Skill 'empty' activated (no instructions available)."
    );
}

#[tokio::test]
async fn returns_validation_error_for_empty_skill_name() {
    let (plugin, agent) = tool_agent_with_test_skill().await;
    let result = invoke_tool(&plugin, &agent, "").await;
    assert!(result.starts_with("Error: Validation failed:"), "{result}");
    assert!(result.contains("/skill_name"), "{result}");
}

// resource listing

async fn resource_response(root: &Path, name: &str, files: &[(&str, &str)], max_files: Option<usize>) -> String {
    let dir = create_skill_dir(
        root,
        name,
        &format!("---\nname: {name}\ndescription: Has resources\n---\nBody."),
        files,
    );
    let plugin = AgentSkills::new(
        AgentSkillsConfig::builder()
            .skills([dir])
            .maybe_max_resource_files(max_files)
            .build(),
    );
    let mut agent = local_agent();
    plugin.init_agent(&mut agent).await.unwrap();
    invoke_tool(&plugin, &agent, name).await
}

#[tokio::test]
async fn lists_files_from_scripts_references_assets() {
    let root = tempfile::tempdir().unwrap();
    let text = resource_response(
        root.path(),
        "resource-skill",
        &[
            ("scripts/setup.sh", "#!/bin/bash"),
            ("references/api.md", "# API Docs"),
            ("assets/logo.png", "binary"),
            ("assets/icons/small/x.png", "nested"),
        ],
        None,
    )
    .await;
    let dir = root.path().join("resource-skill");
    assert_eq!(
        text,
        format!(
            "Body.\n\n---\nLocation: {}/SKILL.md\n\nAvailable resources:\n  scripts/setup.sh\n  references/api.md\n  assets/icons/small/x.png\n  assets/logo.png",
            dir.to_str().unwrap()
        )
    );
}

#[tokio::test]
async fn handles_missing_resource_directories_gracefully() {
    let root = tempfile::tempdir().unwrap();
    let text = resource_response(root.path(), "no-resources", &[], None).await;
    assert!(!text.contains("Available resources"));
}

#[tokio::test]
async fn truncates_at_max_resource_files() {
    let root = tempfile::tempdir().unwrap();
    let files = (0..5)
        .map(|index| (format!("scripts/file{index}.sh"), format!("script {index}")))
        .collect::<Vec<_>>();
    let files = files
        .iter()
        .map(|(path, content)| (path.as_str(), content.as_str()))
        .collect::<Vec<_>>();
    let text = resource_response(root.path(), "many-files", &files, Some(3)).await;
    assert!(text.ends_with(
        "Available resources:\n  scripts/file0.sh\n  scripts/file1.sh\n  scripts/file2.sh\n  ... (truncated at 3 files)"
    ));
}

#[tokio::test]
async fn stops_listing_resources_three_levels_down() {
    let root = tempfile::tempdir().unwrap();
    let text = resource_response(
        root.path(),
        "deep-skill",
        &[("scripts/a/b/c/deep.sh", "deep"), ("scripts/a/b/shallow.sh", "shallow")],
        None,
    )
    .await;
    assert!(text.contains("scripts/a/b/shallow.sh"));
    assert!(!text.contains("deep.sh"));
}

// setAvailableSkills

#[tokio::test]
async fn replaces_all_skills() {
    let plugin = plugin([make_skill("original")]);
    assert_eq!(plugin.get_available_skills(None).await.len(), 1);
    plugin.set_available_skills([make_skill("new-a"), make_skill("new-b")]);
    assert_eq!(names(&plugin.get_available_skills(None).await), ["new-a", "new-b"]);
}

// URL skill resolution

const SAMPLE_CONTENT: &str = "---\nname: url-skill\ndescription: A URL skill\n---\n# Instructions\n";

#[tokio::test]
async fn resolves_a_url_string_as_a_skill_source() {
    let (plugin, _calls) = url_plugin(&["https://example.com/SKILL.md"], Ok(SAMPLE_CONTENT));
    plugin.init_agent(&mut local_agent()).await.unwrap();
    assert_eq!(names(&plugin.get_available_skills(None).await), ["url-skill"]);
}

#[tokio::test]
async fn resolves_a_mix_of_url_and_local_filesystem_sources() {
    let root = tempfile::tempdir().unwrap();
    let dir = create_skill_dir(
        root.path(),
        "local-skill",
        "---\nname: local-skill\ndescription: A local skill\n---\nBody.",
        &[],
    );
    let fetcher = UrlFetcher::new(|_url| Box::pin(async { Ok(SAMPLE_CONTENT.to_owned()) }));
    let config = AgentSkillsConfig::builder()
        .skills(["https://example.com/SKILL.md".to_owned(), dir])
        .build();
    let plugin = AgentSkills::with_fetcher(config, fetcher);
    let mut agent = local_agent();
    plugin.init_agent(&mut agent).await.unwrap();
    assert_eq!(
        names(&plugin.get_available_skills(Some(&agent)).await),
        ["url-skill", "local-skill"]
    );
}

#[tokio::test]
async fn skips_a_failed_url_fetch_gracefully() {
    let (logs, _guard) = record_logs();
    let status = FetchError::Status {
        status: 404,
        status_text: "Not Found".into(),
    };
    let (plugin, _calls) = url_plugin(&["https://example.com/broken/SKILL.md"], Err(status));
    plugin.init_agent(&mut local_agent()).await.unwrap();
    assert!(plugin.get_available_skills(None).await.is_empty());
    assert!(logs.text().contains(
        "url=<https://example.com/broken/SKILL.md> | failed to load skill from URL: Error: url=<https://example.com/broken/SKILL.md> | HTTP 404: Not Found"
    ));
}

#[tokio::test]
async fn warns_on_duplicate_skill_names_from_urls() {
    let (logs, _guard) = record_logs();
    let (plugin, _calls) = url_plugin(
        &["https://example.com/a/SKILL.md", "https://example.com/b/SKILL.md"],
        Ok(SAMPLE_CONTENT),
    );
    plugin.init_agent(&mut local_agent()).await.unwrap();
    assert_eq!(plugin.get_available_skills(None).await.len(), 1);
    assert!(
        logs.text()
            .contains("name=<url-skill> | duplicate skill name, overwriting previous skill")
    );
}

#[tokio::test]
async fn awaits_url_sources_in_init_agent() {
    let (plugin, calls) = url_plugin(&["https://example.com/SKILL.md"], Ok(SAMPLE_CONTENT));
    let mut agent = local_agent();
    plugin.init_agent(&mut agent).await.unwrap();
    assert_eq!(calls.load(AtomicOrdering::SeqCst), 1);
    assert_eq!(plugin.get_available_skills(None).await.len(), 1);
    assert_eq!(agent.hooks().len(), 1);
    fire_before_invocation(&mut agent).await;
    assert_eq!(calls.load(AtomicOrdering::SeqCst), 1);
}

#[tokio::test]
async fn shares_one_plugin_across_agents_with_separate_state() {
    let (plugin, first) = tool_agent_with_test_skill().await;
    let mut second = local_agent();
    plugin.init_agent(&mut second).await.unwrap();
    invoke_tool(&plugin, &first, "test-skill").await;
    assert_eq!(plugin.get_activated_skills(&first), ["test-skill"]);
    assert!(plugin.get_activated_skills(&second).is_empty());
}

#[test]
fn converts_strings_to_paths_or_urls_by_prefix() {
    assert_eq!(
        SkillSource::from("https://x/SKILL.md"),
        SkillSource::Url("https://x/SKILL.md".into())
    );
    assert_eq!(
        SkillSource::from("http://x/SKILL.md"),
        SkillSource::Path("http://x/SKILL.md".into())
    );
    assert_eq!(SkillSource::from("./skills"), SkillSource::Path("./skills".into()));
}

#[test]
fn converts_paths_to_path_sources() {
    let dir = std::path::PathBuf::from("https://not-a-url/skills");
    assert_eq!(
        SkillSource::from(dir.as_path()),
        SkillSource::Path("https://not-a-url/skills".into())
    );
    assert_eq!(
        SkillSource::from(&dir),
        SkillSource::Path("https://not-a-url/skills".into())
    );
    assert_eq!(
        SkillSource::from(dir),
        SkillSource::Path("https://not-a-url/skills".into())
    );
    let config = AgentSkillsConfig::builder()
        .skills([std::path::PathBuf::from("./skills")])
        .build();
    assert_eq!(config.skills, [SkillSource::Path("./skills".into())]);
}

#[tokio::test]
async fn activates_a_skill_through_an_agent_run() {
    use crate::testing::{MockModel, MockTurn};
    use crate::types::{ContentBlock, ToolUseBlock};

    let model = MockModel::from_turns([
        MockTurn::content([ContentBlock::ToolUse(ToolUseBlock::new(
            "skills",
            "use-1",
            json!({"skill_name": "pdf-skill"}),
        ))]),
        MockTurn::text("done"),
    ]);
    let mut agent = crate::Agent::builder()
        .model(model.clone())
        .system_prompt("Base.")
        .plugins([plugin([make_skill_with("pdf-skill", "Process PDFs")])])
        .printer(false)
        .build()
        .unwrap();
    agent.invoke("Read the PDF").await.unwrap();

    let requests = model.requests();
    let Some(SystemPrompt::Text(prompt)) = &requests[0].system_prompt else {
        panic!("expected a string prompt");
    };
    assert!(prompt.starts_with("Base.\n\n<available_skills>\n<skill>\n<name>pdf-skill</name>"));
    assert!(requests[0].tool_specs.iter().any(|spec| spec.name == "skills"));
    let result = serde_json::to_value(&requests[1].messages[2]).unwrap();
    assert_eq!(
        result["content"][0]["toolResult"]["content"][0]["text"],
        json!("Instructions for pdf-skill")
    );
    assert_eq!(
        agent.app_state().get_value("agent_skills").unwrap()["activatedSkills"],
        json!(["pdf-skill"])
    );
}

/// Records the paths it reads and lists, and serves them from the host.
#[derive(Default)]
struct RecordingSandbox {
    paths: std::sync::Mutex<Vec<String>>,
}

#[async_trait]
impl Sandbox for RecordingSandbox {
    fn execute_streaming(
        &self,
        command: &str,
        options: crate::sandbox::ExecuteOptions,
    ) -> crate::sandbox::ExecutionStream {
        crate::sandbox::default_sandbox().execute_streaming(command, options)
    }

    fn execute_code_streaming(
        &self,
        code: &str,
        language: &str,
        options: crate::sandbox::ExecuteOptions,
    ) -> crate::sandbox::ExecutionStream {
        crate::sandbox::default_sandbox().execute_code_streaming(code, language, options)
    }

    async fn read_file(&self, path: &str) -> Result<Vec<u8>> {
        self.paths.lock().unwrap().push(path.to_owned());
        crate::sandbox::default_sandbox().read_file(path).await
    }

    async fn write_file(&self, path: &str, content: &[u8]) -> Result<()> {
        crate::sandbox::default_sandbox().write_file(path, content).await
    }

    async fn remove_file(&self, path: &str) -> Result<()> {
        crate::sandbox::default_sandbox().remove_file(path).await
    }

    async fn list_files(&self, path: &str) -> Result<Vec<FileInfo>> {
        self.paths.lock().unwrap().push(path.to_owned());
        crate::sandbox::default_sandbox().list_files(path).await
    }
}

#[tokio::test]
async fn reads_path_skills_and_their_resources_through_the_agents_sandbox() {
    let root = tempfile::tempdir().unwrap();
    let dir = create_skill_dir(
        root.path(),
        "boxed-skill",
        "---\nname: boxed-skill\ndescription: In a sandbox\n---\nBody.",
        &[("scripts/run.sh", "echo")],
    );
    let sandbox = Arc::new(RecordingSandbox::default());
    let plugin = plugin([dir.clone()]);
    let mut agent = local_agent();
    agent.set_sandbox(Some(sandbox.clone()));
    plugin.init_agent(&mut agent).await.unwrap();
    assert_eq!(names(&plugin.get_available_skills(Some(&agent)).await), ["boxed-skill"]);
    let loaded = sandbox.paths.lock().unwrap().len();
    assert!(loaded > 0);

    let text = invoke_tool(&plugin, &agent, "boxed-skill").await;
    assert!(text.contains("scripts/run.sh"), "{text}");
    assert!(
        sandbox.paths.lock().unwrap()[loaded..]
            .iter()
            .any(|path| path.starts_with(&dir))
    );
}
