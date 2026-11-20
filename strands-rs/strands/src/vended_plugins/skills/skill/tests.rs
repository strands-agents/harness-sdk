use std::fs;
use std::path::{Path, PathBuf};

use serde_json::json;

use super::*;
use crate::test_support::capture_logs;

fn create_skill_dir(root: &Path, name: &str, content: &str, filename: &str) -> PathBuf {
    let dir = root.join(name);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join(filename), content).unwrap();
    dir
}

fn lenient() -> SkillLoadOptions {
    SkillLoadOptions::default()
}

fn content_error(content: &str, options: SkillLoadOptions) -> String {
    Skill::from_content(content, options).unwrap_err().to_string()
}

fn fetcher(result: std::result::Result<&'static str, FetchError>) -> UrlFetcher {
    UrlFetcher::new(move |_url| {
        let result = result.clone().map(str::to_owned);
        Box::pin(async move { result })
    })
}

// constructor

#[test]
fn creates_a_skill_with_required_fields() {
    let skill = Skill::new(SkillConfig {
        name: "test-skill".into(),
        description: "A test skill".into(),
        ..Default::default()
    });
    assert_eq!(skill.name(), "test-skill");
    assert_eq!(skill.description(), "A test skill");
    assert_eq!(skill.instructions(), "");
    assert_eq!(skill.path(), None);
    assert_eq!(skill.allowed_tools(), None);
    assert!(skill.metadata().is_empty());
    assert_eq!(skill.license(), None);
    assert_eq!(skill.compatibility(), None);
}

#[test]
fn creates_a_skill_with_all_fields() {
    let skill: Skill = SkillConfig::builder()
        .name("full-skill")
        .description("Full description")
        .instructions("# Instructions\nDo things")
        .path("/some/path")
        .allowed_tools(vec!["bash".into(), "file-editor".into()])
        .metadata(json!({"author": "test"}).as_object().unwrap().clone())
        .license("Apache-2.0")
        .compatibility("v1.0+")
        .build()
        .into();
    assert_eq!(skill.name(), "full-skill");
    assert_eq!(skill.description(), "Full description");
    assert_eq!(skill.instructions(), "# Instructions\nDo things");
    assert_eq!(skill.path(), Some("/some/path"));
    assert_eq!(
        skill.allowed_tools(),
        Some(&["bash".to_owned(), "file-editor".to_owned()][..])
    );
    assert_eq!(JsonValue::Object(skill.metadata().clone()), json!({"author": "test"}));
    assert_eq!(skill.license(), Some("Apache-2.0"));
    assert_eq!(skill.compatibility(), Some("v1.0+"));
}

// fromContent

#[test]
fn parses_valid_skill_md_content() {
    let skill = Skill::from_content(
        "---\nname: my-skill\ndescription: Does something useful\n---\n# Instructions\nFollow these steps.",
        lenient(),
    )
    .unwrap();
    assert_eq!(skill.name(), "my-skill");
    assert_eq!(skill.description(), "Does something useful");
    assert_eq!(skill.instructions(), "# Instructions\nFollow these steps.");
}

#[test]
fn parses_content_with_allowed_tools_as_space_delimited_string() {
    let skill = Skill::from_content(
        "---\nname: my-skill\ndescription: A skill\nallowed-tools: bash file-editor\n---\nInstructions here.",
        lenient(),
    )
    .unwrap();
    assert_eq!(
        skill.allowed_tools(),
        Some(&["bash".to_owned(), "file-editor".to_owned()][..])
    );
}

#[test]
fn parses_content_with_allowed_tools_as_yaml_list() {
    let skill = Skill::from_content(
        "---\nname: my-skill\ndescription: A skill\nallowed-tools:\n  - bash\n  - file-editor\n---\nInstructions here.",
        lenient(),
    )
    .unwrap();
    assert_eq!(
        skill.allowed_tools(),
        Some(&["bash".to_owned(), "file-editor".to_owned()][..])
    );
}

#[test]
fn parses_content_with_allowed_tools_underscore_variant() {
    let skill = Skill::from_content(
        "---\nname: my-skill\ndescription: A skill\nallowed_tools: bash notebook\n---\nInstructions here.",
        lenient(),
    )
    .unwrap();
    assert_eq!(
        skill.allowed_tools(),
        Some(&["bash".to_owned(), "notebook".to_owned()][..])
    );
}

#[test]
fn parses_content_with_metadata() {
    let skill = Skill::from_content(
        "---\nname: my-skill\ndescription: A skill\nmetadata:\n  author: test-user\n  version: 1\n---\nBody.",
        lenient(),
    )
    .unwrap();
    assert_eq!(
        JsonValue::Object(skill.metadata().clone()),
        json!({"author": "test-user", "version": 1})
    );
}

#[test]
fn parses_content_with_license_and_compatibility() {
    let skill = Skill::from_content(
        "---\nname: my-skill\ndescription: A skill\nlicense: MIT\ncompatibility: strands-agents >= 1.0\n---\nBody.",
        lenient(),
    )
    .unwrap();
    assert_eq!(skill.license(), Some("MIT"));
    assert_eq!(skill.compatibility(), Some("strands-agents >= 1.0"));
}

#[test]
fn throws_if_content_does_not_start_with_dashes() {
    assert_eq!(
        content_error("no frontmatter", lenient()),
        "SKILL.md must start with --- frontmatter delimiter"
    );
}

#[test]
fn throws_if_closing_dashes_is_missing() {
    assert_eq!(
        content_error("---\nname: test\n", lenient()),
        "SKILL.md frontmatter missing closing --- delimiter"
    );
}

#[test]
fn throws_if_name_is_missing() {
    assert_eq!(
        content_error("---\ndescription: no name\n---\nBody.", lenient()),
        "SKILL.md content must have a 'name' field in frontmatter"
    );
}

#[test]
fn throws_if_description_is_missing() {
    assert_eq!(
        content_error("---\nname: my-skill\n---\nBody.", lenient()),
        "SKILL.md content must have a 'description' field in frontmatter"
    );
}

#[test]
fn handles_empty_body() {
    let skill = Skill::from_content("---\nname: my-skill\ndescription: A skill\n---", lenient()).unwrap();
    assert_eq!(skill.instructions(), "");
}

#[test]
fn warns_but_does_not_throw_for_invalid_name_in_lenient_mode() {
    let (skill, logs) =
        capture_logs(|| Skill::from_content("---\nname: INVALID_NAME\ndescription: A skill\n---\nBody.", lenient()));
    assert_eq!(skill.unwrap().name(), "INVALID_NAME");
    assert!(logs.contains("WARN name=<INVALID_NAME> | skill name should be 1-64 lowercase alphanumeric characters or hyphens, should not start/end with hyphen"));
}

#[test]
fn throws_for_invalid_name_in_strict_mode() {
    assert_eq!(
        content_error(
            "---\nname: INVALID_NAME\ndescription: A skill\n---\nBody.",
            SkillLoadOptions::strict()
        ),
        "name=<INVALID_NAME> | skill name should be 1-64 lowercase alphanumeric characters or hyphens, should not start/end with hyphen"
    );
}

#[test]
fn throws_for_empty_name_in_strict_mode() {
    assert_eq!(
        content_error("---\nname: \"\"\ndescription: A skill\n---\nBody.", lenient()),
        "SKILL.md content must have a 'name' field in frontmatter"
    );
}

#[test]
fn throws_for_name_exceeding_length_limit_in_strict_mode() {
    let name = "a".repeat(65);
    assert_eq!(
        content_error(
            &format!("---\nname: {name}\ndescription: A skill\n---\nBody."),
            SkillLoadOptions::strict()
        ),
        format!("name=<{name}> | skill name exceeds 64 character limit")
    );
}

#[test]
fn throws_for_consecutive_hyphens_in_strict_mode() {
    assert_eq!(
        content_error(
            "---\nname: my--skill\ndescription: A skill\n---\nBody.",
            SkillLoadOptions::strict()
        ),
        "name=<my--skill> | skill name contains consecutive hyphens"
    );
}

#[test]
fn handles_body_containing_dashes_horizontal_rules() {
    let content = "---\nname: my-skill\ndescription: A skill\n---\n# Instructions\n\nFirst section.\n\n---\n\nSecond section after horizontal rule.\n\n---\n\nThird section.";
    let skill = Skill::from_content(content, lenient()).unwrap();
    assert_eq!(skill.name(), "my-skill");
    assert_eq!(
        skill.instructions(),
        "# Instructions\n\nFirst section.\n\n---\n\nSecond section after horizontal rule.\n\n---\n\nThird section."
    );
}

#[test]
fn handles_body_with_only_whitespace_after_frontmatter() {
    let skill = Skill::from_content("---\nname: my-skill\ndescription: A skill\n---\n\n   ", lenient()).unwrap();
    assert_eq!(skill.name(), "my-skill");
    assert_eq!(skill.instructions(), "");
}

#[test]
fn handles_frontmatter_value_containing_dashes_inline() {
    let skill = Skill::from_content(
        "---\nname: my-skill\ndescription: Use this --- for special cases\n---\nBody.",
        lenient(),
    )
    .unwrap();
    assert_eq!(skill.name(), "my-skill");
    assert_eq!(skill.description(), "Use this --- for special cases");
}

#[test]
fn ignores_non_object_metadata() {
    let skill = Skill::from_content(
        "---\nname: my-skill\ndescription: A skill\nmetadata: just-a-string\n---\nBody.",
        lenient(),
    )
    .unwrap();
    assert!(skill.metadata().is_empty());
}

#[test]
fn ignores_array_metadata() {
    let skill = Skill::from_content(
        "---\nname: my-skill\ndescription: A skill\nmetadata:\n  - item1\n  - item2\n---\nBody.",
        lenient(),
    )
    .unwrap();
    assert!(skill.metadata().is_empty());
}

#[test]
fn handles_allowed_tools_as_empty_string() {
    let skill = Skill::from_content(
        "---\nname: my-skill\ndescription: A skill\nallowed-tools: \"\"\n---\nBody.",
        lenient(),
    )
    .unwrap();
    assert_eq!(skill.allowed_tools(), None);
}

#[test]
fn filters_null_entries_from_allowed_tools_array() {
    let skill = Skill::from_content(
        "---\nname: my-skill\ndescription: A skill\nallowed-tools:\n  - bash\n  - null\n  - file-editor\n---\nBody.",
        lenient(),
    )
    .unwrap();
    assert_eq!(
        skill.allowed_tools(),
        Some(&["bash".to_owned(), "file-editor".to_owned()][..])
    );
}

#[test]
fn quotes_unquoted_colons_when_the_yaml_does_not_parse() {
    let (skill, logs) = capture_logs(|| {
        Skill::from_content(
            "---\nname: my-skill\ndescription: Use when: user says \"hello\" \\ bye\n---\nBody.",
            lenient(),
        )
    });
    assert_eq!(skill.unwrap().description(), "Use when: user says \"hello\" \\ bye");
    assert!(logs.contains("WARN YAML parse failed, retrying with colon-quoting fallback"));
}

#[test]
fn stringifies_non_string_license_and_allowed_tools_entries() {
    let skill = Skill::from_content(
        "---\nname: my-skill\ndescription: A skill\nlicense: 2.0\ncompatibility: true\nallowed-tools: [1, bash]\n---\nBody.",
        lenient(),
    )
    .unwrap();
    assert_eq!(skill.license(), Some("2"));
    assert_eq!(skill.compatibility(), Some("true"));
    assert_eq!(skill.allowed_tools(), Some(&["1".to_owned(), "bash".to_owned()][..]));
}

#[test]
fn closes_the_frontmatter_only_on_a_line_of_three_dashes() {
    let skill = Skill::from_content(
        "---\nname: my-skill\ndescription: A skill\n----\nkey: value\n---   \nBody.",
        lenient(),
    );
    assert!(skill.is_err());
    let skill = Skill::from_content("---\nname: my-skill\ndescription: A skill\n---   \r\nBody.", lenient()).unwrap();
    assert_eq!(skill.instructions(), "Body.");
}

// fromFile

#[test]
fn loads_a_skill_from_a_directory() {
    let root = tempfile::tempdir().unwrap();
    let dir = create_skill_dir(
        root.path(),
        "my-skill",
        "---\nname: my-skill\ndescription: A test skill\n---\n# Instructions\nDo the thing.",
        "SKILL.md",
    );
    let skill = Skill::from_file(&dir, lenient()).unwrap();
    assert_eq!(skill.name(), "my-skill");
    assert_eq!(skill.description(), "A test skill");
    assert_eq!(skill.instructions(), "# Instructions\nDo the thing.");
    assert_eq!(skill.path(), Some(dir.to_str().unwrap()));
}

#[test]
fn loads_a_skill_from_a_skill_md_file_path() {
    let root = tempfile::tempdir().unwrap();
    let dir = create_skill_dir(
        root.path(),
        "my-skill",
        "---\nname: my-skill\ndescription: A test skill\n---\nBody.",
        "SKILL.md",
    );
    let skill = Skill::from_file(dir.join("SKILL.md"), lenient()).unwrap();
    assert_eq!(skill.name(), "my-skill");
    assert_eq!(skill.path(), Some(dir.to_str().unwrap()));
}

#[test]
fn finds_lowercase_skill_md_as_fallback() {
    let root = tempfile::tempdir().unwrap();
    let dir = create_skill_dir(
        root.path(),
        "my-skill",
        "---\nname: my-skill\ndescription: A test skill\n---\nBody.",
        "skill.md",
    );
    assert_eq!(Skill::from_file(&dir, lenient()).unwrap().name(), "my-skill");
}

#[test]
fn throws_for_non_existent_path() {
    let error = Skill::from_file("/does/not/exist", lenient()).unwrap_err().to_string();
    assert!(error.ends_with("does/not/exist> | skill path does not exist or is not a valid skill directory"));
}

#[test]
fn warns_when_skill_name_does_not_match_directory_name() {
    let root = tempfile::tempdir().unwrap();
    let dir = create_skill_dir(
        root.path(),
        "wrong-dir-name",
        "---\nname: actual-skill-name\ndescription: Mismatched name\n---\nBody.",
        "SKILL.md",
    );
    let (skill, logs) = capture_logs(|| Skill::from_file(&dir, lenient()));
    assert_eq!(skill.unwrap().name(), "actual-skill-name");
    assert!(logs.contains(
        "name=<actual-skill-name>, directory=<wrong-dir-name> | skill name does not match parent directory name"
    ));
}

#[test]
fn throws_when_skill_name_does_not_match_directory_in_strict_mode() {
    let root = tempfile::tempdir().unwrap();
    let dir = create_skill_dir(
        root.path(),
        "wrong-dir-name",
        "---\nname: actual-skill-name\ndescription: Mismatched name\n---\nBody.",
        "SKILL.md",
    );
    let error = Skill::from_file(&dir, SkillLoadOptions::strict())
        .unwrap_err()
        .to_string();
    assert!(error.contains("does not match parent directory name"));
}

#[test]
fn resolves_relative_segments_in_the_skill_path() {
    let root = tempfile::tempdir().unwrap();
    let dir = create_skill_dir(
        root.path(),
        "my-skill",
        "---\nname: my-skill\ndescription: A test skill\n---\nBody.",
        "SKILL.md",
    );
    let skill = Skill::from_file(dir.join("..").join("my-skill").join("."), SkillLoadOptions::strict()).unwrap();
    assert_eq!(skill.path(), Some(dir.to_str().unwrap()));
}

// fromDirectory

#[test]
fn loads_all_skills_from_a_directory() {
    let root = tempfile::tempdir().unwrap();
    create_skill_dir(
        root.path(),
        "skill-a",
        "---\nname: skill-a\ndescription: First skill\n---\nInstructions A.",
        "SKILL.md",
    );
    create_skill_dir(
        root.path(),
        "skill-b",
        "---\nname: skill-b\ndescription: Second skill\n---\nInstructions B.",
        "SKILL.md",
    );
    let skills = Skill::from_directory(root.path(), lenient()).unwrap();
    let names = skills.iter().map(Skill::name).collect::<Vec<_>>();
    assert_eq!(names, ["skill-a", "skill-b"]);
}

#[test]
fn skips_directories_without_skill_md() {
    let root = tempfile::tempdir().unwrap();
    create_skill_dir(
        root.path(),
        "valid-skill",
        "---\nname: valid-skill\ndescription: Has SKILL.md\n---\nBody.",
        "SKILL.md",
    );
    create_skill_dir(root.path(), "no-skill-md", "not a skill", "README.md");
    let skills = Skill::from_directory(root.path(), lenient()).unwrap();
    assert_eq!(skills.len(), 1);
    assert_eq!(skills[0].name(), "valid-skill");
}

#[test]
fn skips_non_directory_children() {
    let root = tempfile::tempdir().unwrap();
    create_skill_dir(
        root.path(),
        "valid-skill",
        "---\nname: valid-skill\ndescription: Has SKILL.md\n---\nBody.",
        "SKILL.md",
    );
    fs::write(root.path().join("some-file.txt"), "not a directory").unwrap();
    assert_eq!(Skill::from_directory(root.path(), lenient()).unwrap().len(), 1);
}

#[test]
fn skips_skills_with_invalid_content() {
    let root = tempfile::tempdir().unwrap();
    create_skill_dir(
        root.path(),
        "valid-skill",
        "---\nname: valid-skill\ndescription: Good skill\n---\nBody.",
        "SKILL.md",
    );
    create_skill_dir(
        root.path(),
        "bad-skill",
        "---\ndescription: Missing name\n---\nBody.",
        "SKILL.md",
    );
    let (skills, logs) = capture_logs(|| Skill::from_directory(root.path(), lenient()).unwrap());
    assert_eq!(skills.len(), 1);
    assert_eq!(skills[0].name(), "valid-skill");
    assert!(
        logs.contains("| skipping skill due to error: Error: SKILL.md content must have a 'name' field in frontmatter")
    );
}

#[test]
fn throws_for_non_existent_directory() {
    let error = Skill::from_directory("/does/not/exist", lenient())
        .unwrap_err()
        .to_string();
    assert!(error.ends_with("| skills directory does not exist"));
}

#[test]
fn returns_empty_array_for_directory_with_no_skills() {
    let root = tempfile::tempdir().unwrap();
    assert!(Skill::from_directory(root.path(), lenient()).unwrap().is_empty());
}

#[test]
fn skips_skills_with_completely_broken_skill_md_no_frontmatter() {
    let root = tempfile::tempdir().unwrap();
    create_skill_dir(
        root.path(),
        "valid-skill",
        "---\nname: valid-skill\ndescription: Good skill\n---\nBody.",
        "SKILL.md",
    );
    create_skill_dir(
        root.path(),
        "broken-skill",
        "totally broken, no frontmatter at all",
        "SKILL.md",
    );
    let skills = Skill::from_directory(root.path(), lenient()).unwrap();
    assert_eq!(skills.len(), 1);
    assert_eq!(skills[0].name(), "valid-skill");
}

// fromUrl

const SAMPLE_CONTENT: &str = "---\nname: my-skill\ndescription: A remote skill\n---\nRemote instructions.\n";

#[tokio::test]
async fn returns_a_skill_from_a_valid_url() {
    let skill = Skill::from_url_with(
        "https://raw.githubusercontent.com/org/repo/main/SKILL.md",
        lenient(),
        &fetcher(Ok(SAMPLE_CONTENT)),
    )
    .await
    .unwrap();
    assert_eq!(skill.name(), "my-skill");
    assert_eq!(skill.description(), "A remote skill");
    assert_eq!(skill.instructions(), "Remote instructions.");
    assert_eq!(skill.path(), None);
}

#[tokio::test]
async fn rejects_non_https_urls() {
    let error = Skill::from_url("./local-path", lenient()).await.unwrap_err();
    assert_eq!(error.to_string(), "url=<./local-path> | not a valid HTTPS URL");
}

#[tokio::test]
async fn rejects_http_urls() {
    let error = Skill::from_url("http://example.com/SKILL.md", lenient())
        .await
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        "url=<http://example.com/SKILL.md> | not a valid HTTPS URL"
    );
}

#[tokio::test]
async fn throws_on_http_error_responses() {
    let status = FetchError::Status {
        status: 404,
        status_text: "Not Found".into(),
    };
    let error = Skill::from_url_with("https://example.com/SKILL.md", lenient(), &fetcher(Err(status)))
        .await
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        "url=<https://example.com/SKILL.md> | HTTP 404: Not Found"
    );
}

#[tokio::test]
async fn throws_on_network_errors() {
    let failed = FetchError::Failed("Connection refused".into());
    let error = Skill::from_url_with("https://example.com/SKILL.md", lenient(), &fetcher(Err(failed)))
        .await
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        "url=<https://example.com/SKILL.md> | failed to fetch skill: Connection refused"
    );
}

#[tokio::test]
async fn forwards_strict_mode_to_from_content() {
    let error = Skill::from_url_with(
        "https://example.com/SKILL.md",
        SkillLoadOptions::strict(),
        &fetcher(Ok("---\nname: BAD_NAME\ndescription: Bad\n---\nBody.")),
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("skill name should be"));
}

#[tokio::test]
async fn throws_on_invalid_content_e_g_html_page() {
    let error = Skill::from_url_with(
        "https://example.com/SKILL.md",
        lenient(),
        &fetcher(Ok("<html><body>Not a SKILL.md</body></html>")),
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("frontmatter"));
}
