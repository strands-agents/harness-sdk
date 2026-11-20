use super::*;
use crate::agent::ToolAgent;
use crate::vended_tools::test_support::{agent, error_text, ok_text};

fn with_notebooks(notebooks: JsonValue) -> ToolAgent {
    let agent = agent();
    agent.app_state().set(STATE_KEY, notebooks).unwrap();
    agent
}

fn notebooks(agent: &ToolAgent) -> JsonValue {
    agent.app_state().get_value(STATE_KEY).unwrap()
}

async fn ok(agent: &ToolAgent, input: JsonValue) -> String {
    ok_text(&notebook(), input, agent).await
}

async fn err(agent: &ToolAgent, input: JsonValue) -> String {
    error_text(&notebook(), input, agent).await
}

const FIVE_LINES: &str = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5";
const TODO: &str = "# Todo List\n\n[ ] Task 1\n[ ] Task 2\n[x] Task 3";

#[tokio::test]
async fn creates_an_empty_notebook_with_default_name() {
    let agent = with_notebooks(json!({}));
    assert_eq!(
        ok(&agent, json!({"mode": "create"})).await,
        "Created notebook 'default' (empty)"
    );
    assert_eq!(notebooks(&agent)["default"], "");
}

#[tokio::test]
async fn creates_an_empty_notebook_with_custom_name() {
    let agent = with_notebooks(json!({}));
    assert_eq!(
        ok(&agent, json!({"mode": "create", "name": "notes"})).await,
        "Created notebook 'notes' (empty)"
    );
    assert_eq!(notebooks(&agent)["notes"], "");
}

#[tokio::test]
async fn creates_a_notebook_with_initial_content() {
    let agent = with_notebooks(json!({}));
    let content = "# My Notes\n\nFirst entry";
    assert_eq!(
        ok(&agent, json!({"mode": "create", "name": "notes", "newStr": content})).await,
        "Created notebook 'notes' with specified content"
    );
    assert_eq!(notebooks(&agent)["notes"], content);
}

#[tokio::test]
async fn overwrites_existing_notebook_on_create() {
    let agent = with_notebooks(json!({"notes": "Old content"}));
    ok(
        &agent,
        json!({"mode": "create", "name": "notes", "newStr": "New content"}),
    )
    .await;
    assert_eq!(notebooks(&agent)["notes"], "New content");
}

#[tokio::test]
async fn lists_default_notebook_when_initialized() {
    let agent = with_notebooks(json!({"default": ""}));
    assert!(ok(&agent, json!({"mode": "list"})).await.contains("default: Empty"));
}

#[tokio::test]
async fn lists_multiple_notebooks_with_line_counts() {
    let agent = with_notebooks(json!({"default": "", "notes": "Line 1\nLine 2\nLine 3", "todo": "Single line"}));
    assert_eq!(
        ok(&agent, json!({"mode": "list"})).await,
        "Available notebooks:\n- default: Empty\n- notes: 3 lines\n- todo: 1 lines"
    );
}

#[tokio::test]
async fn reads_notebooks() {
    let agent = with_notebooks(json!({"default": FIVE_LINES, "notes": "Content here", "empty": ""}));
    assert_eq!(ok(&agent, json!({"mode": "read"})).await, FIVE_LINES);
    assert_eq!(
        ok(&agent, json!({"mode": "read", "name": "notes"})).await,
        "Content here"
    );
    assert_eq!(
        ok(&agent, json!({"mode": "read", "name": "empty"})).await,
        "Notebook 'empty' is empty"
    );
    assert_eq!(
        err(&agent, json!({"mode": "read", "name": "missing"})).await,
        "Notebook 'missing' not found"
    );
}

#[tokio::test]
async fn reads_line_ranges() {
    let agent = with_notebooks(json!({"default": FIVE_LINES}));
    let cases = [
        (json!([2, 4]), "2: Line 2\n3: Line 3\n4: Line 4"),
        (json!([-3, 5]), "3: Line 3\n4: Line 4\n5: Line 5"),
        (json!([1, -2]), "1: Line 1\n2: Line 2\n3: Line 3\n4: Line 4"),
        (json!([-2, -1]), "4: Line 4\n5: Line 5"),
        (
            json!([10, 20]),
            "No lines found in range [10, 20]. Notebook 'default' has 5 line(s).",
        ),
    ];
    for (range, expected) in cases {
        assert_eq!(ok(&agent, json!({"mode": "read", "readRange": range})).await, expected);
    }
}

#[tokio::test]
async fn clamps_a_huge_end_bound() {
    let agent = with_notebooks(json!({"default": "Line 1\nLine 2\nLine 3"}));
    assert_eq!(
        ok(&agent, json!({"mode": "read", "readRange": [1, 1e9]})).await,
        "1: Line 1\n2: Line 2\n3: Line 3"
    );
}

#[tokio::test]
async fn replaces_text() {
    let agent = with_notebooks(json!({"default": TODO, "notes": "Original text"}));
    let replace = |name: &str, old_str: &str, new_str: &str| json!({"mode": "write", "name": name, "oldStr": old_str, "newStr": new_str});
    assert_eq!(
        ok(&agent, replace("default", "[ ] Task 1", "[x] Task 1")).await,
        "Replaced text in notebook 'default'"
    );
    assert_eq!(
        notebooks(&agent)["default"],
        "# Todo List\n\n[x] Task 1\n[ ] Task 2\n[x] Task 3"
    );
    assert_eq!(
        ok(&agent, replace("notes", "Original", "Updated")).await,
        "Replaced text in notebook 'notes'"
    );
    assert_eq!(notebooks(&agent)["notes"], "Updated text");
    ok(
        &agent,
        replace("default", "[x] Task 1\n[ ] Task 2", "[ ] Task 1\n[x] Task 2"),
    )
    .await;
    assert_eq!(
        notebooks(&agent)["default"],
        "# Todo List\n\n[ ] Task 1\n[x] Task 2\n[x] Task 3"
    );
}

#[tokio::test]
async fn preserves_dollar_sign_patterns_in_new_str_literally() {
    let agent = with_notebooks(json!({"default": "const value = getPrice()"}));
    ok(
        &agent,
        json!({"mode": "write", "oldStr": "getPrice()", "newStr": "$& is not $1 or $$"}),
    )
    .await;
    assert_eq!(notebooks(&agent)["default"], "const value = $& is not $1 or $$");
}

#[tokio::test]
async fn write_errors() {
    let agent = with_notebooks(json!({"default": TODO}));
    assert_eq!(
        err(
            &agent,
            json!({"mode": "write", "oldStr": "Nonexistent", "newStr": "New"})
        )
        .await,
        "String 'Nonexistent' not found in notebook 'default'"
    );
    assert_eq!(
        err(
            &agent,
            json!({"mode": "write", "name": "missing", "oldStr": "Old", "newStr": "New"})
        )
        .await,
        "Notebook 'missing' not found"
    );
    assert_eq!(
        err(&agent, json!({"mode": "write", "name": "missing", "newStr": "Entry"})).await,
        "Notebook 'missing' not found"
    );
}

#[tokio::test]
async fn appends_text() {
    let cases = [
        ("First entry", "Second entry", "First entry\nSecond entry"),
        ("", "First entry", "First entry"),
        (
            "First entry\n",
            "Second entry\nThird entry",
            "First entry\nSecond entry\nThird entry",
        ),
    ];
    for (current, new_str, expected) in cases {
        let agent = with_notebooks(json!({"notes": current}));
        assert_eq!(
            ok(&agent, json!({"mode": "write", "name": "notes", "newStr": new_str})).await,
            "Appended text to notebook 'notes'"
        );
        assert_eq!(notebooks(&agent)["notes"], expected);
    }
}

#[tokio::test]
async fn leaves_the_notebook_unchanged_when_new_str_is_empty() {
    let agent = with_notebooks(json!({"notes": "First entry"}));
    assert_eq!(
        ok(&agent, json!({"mode": "write", "name": "notes", "newStr": ""})).await,
        "No changes made to notebook 'notes'"
    );
    assert_eq!(notebooks(&agent)["notes"], "First entry");
}

#[tokio::test]
async fn inserts_lines() {
    let cases = [
        (
            json!(2),
            "Inserted line",
            "Inserted text at line 3 in notebook 'default'",
            "Line 1\nLine 2\nInserted line\nLine 3",
        ),
        (
            json!(0),
            "First line",
            "Inserted text at line 1 in notebook 'default'",
            "First line\nLine 1\nLine 2\nLine 3",
        ),
        (
            json!(-1),
            "Last line",
            "Inserted text at line 4 in notebook 'default'",
            "Line 1\nLine 2\nLine 3\nLast line",
        ),
        (
            json!(-2),
            "Before last",
            "Inserted text at line 3 in notebook 'default'",
            "Line 1\nLine 2\nBefore last\nLine 3",
        ),
        (
            json!("Line 1"),
            "After Line 1",
            "Inserted text at line 2 in notebook 'default'",
            "Line 1\nAfter Line 1\nLine 2\nLine 3",
        ),
        (
            json!("2"),
            "After match",
            "Inserted text at line 3 in notebook 'default'",
            "Line 1\nLine 2\nAfter match\nLine 3",
        ),
    ];
    for (insert_line, new_str, message, expected) in cases {
        let agent = with_notebooks(json!({"default": "Line 1\nLine 2\nLine 3"}));
        let input = json!({"mode": "write", "insertLine": insert_line, "newStr": new_str});
        assert_eq!(ok(&agent, input).await, message);
        assert_eq!(notebooks(&agent)["default"], expected);
    }
}

#[tokio::test]
async fn insert_errors() {
    let agent = with_notebooks(json!({"default": "Line 1\nLine 2\nLine 3"}));
    assert_eq!(
        err(
            &agent,
            json!({"mode": "write", "insertLine": "Nonexistent", "newStr": "New line"})
        )
        .await,
        "Text 'Nonexistent' not found in notebook 'default'"
    );
    assert_eq!(
        err(
            &agent,
            json!({"mode": "write", "insertLine": 100, "newStr": "New line"})
        )
        .await,
        "Line number out of range"
    );
}

#[tokio::test]
async fn inserts_into_custom_notebook() {
    let agent = with_notebooks(json!({"notes": "First\nSecond"}));
    let input = json!({"mode": "write", "name": "notes", "insertLine": 1, "newStr": "Middle"});
    assert_eq!(ok(&agent, input).await, "Inserted text at line 2 in notebook 'notes'");
    assert_eq!(notebooks(&agent)["notes"], "First\nMiddle\nSecond");
}

#[tokio::test]
async fn clears_notebooks() {
    let agent = with_notebooks(json!({"default": "Some content", "notes": "More content"}));
    assert_eq!(
        ok(&agent, json!({"mode": "clear", "name": "notes"})).await,
        "Cleared notebook 'notes'"
    );
    assert_eq!(notebooks(&agent), json!({"default": "Some content", "notes": ""}));
    assert_eq!(ok(&agent, json!({"mode": "clear"})).await, "Cleared notebook 'default'");
    assert_eq!(notebooks(&agent)["default"], "");
    assert_eq!(
        err(&agent, json!({"mode": "clear", "name": "missing"})).await,
        "Notebook 'missing' not found"
    );
}

#[tokio::test]
async fn persists_notebooks_across_operations() {
    let agent = with_notebooks(json!({}));
    ok(&agent, json!({"mode": "create", "name": "notes", "newStr": "Initial"})).await;
    ok(&agent, json!({"mode": "write", "name": "notes", "newStr": "Added"})).await;
    assert_eq!(
        ok(&agent, json!({"mode": "read", "name": "notes"})).await,
        "Initial\nAdded"
    );
    assert_eq!(notebooks(&agent)["notes"], "Initial\nAdded");
}

#[tokio::test]
async fn rejects_invalid_write_parameters() {
    let agent = with_notebooks(json!({"default": "Line 1\nLine 2"}));
    let expected = format!("Validation failed:\n- {WRITE_REQUIREMENTS}");
    for input in [
        json!({"mode": "write", "oldStr": "Old"}),
        json!({"mode": "write", "insertLine": 1}),
        json!({"mode": "write"}),
        json!({"mode": "write", "oldStr": "Line 1", "newStr": "Replaced", "insertLine": 0}),
    ] {
        assert_eq!(err(&agent, input).await, expected);
    }
}

#[tokio::test]
async fn rejects_malformed_state() {
    let agent = with_notebooks(json!(42));
    assert_eq!(
        err(&agent, json!({"mode": "list"})).await,
        "Malformed notebooks state: expected a plain object"
    );
    let agent = with_notebooks(json!({"notes": 123}));
    assert_eq!(
        err(&agent, json!({"mode": "list"})).await,
        "Malformed notebooks state: keys and values must be strings"
    );
}

#[test]
fn validates_factory_options() {
    let error = make_notebook(MakeNotebookOptions::builder().name("").build()).unwrap_err();
    assert_eq!(error.to_string(), "name must be a non-empty string");
    let error = make_notebook(MakeNotebookOptions::builder().max_notebook_size_bytes(0).build()).unwrap_err();
    assert_eq!(error.to_string(), "maxNotebookSizeBytes must be a positive integer");
    make_notebook(MakeNotebookOptions::builder().max_notebook_size_bytes(1024).build()).unwrap();
}

async fn capped(max: usize, agent: &ToolAgent, input: JsonValue) -> String {
    let tool = make_notebook(MakeNotebookOptions::builder().max_notebook_size_bytes(max).build()).unwrap();
    error_text(&tool, input, agent).await
}

#[tokio::test]
async fn enforces_the_size_cap() {
    let agent = with_notebooks(json!({}));
    let message = capped(
        10,
        &agent,
        json!({"mode": "create", "name": "nb", "newStr": "This is longer than ten bytes"}),
    )
    .await;
    assert!(message.contains("would exceed maximum of 10 bytes"));

    let agent = with_notebooks(json!({"notes": "Hello"}));
    let input = json!({"mode": "write", "name": "notes", "newStr": "This string pushes it over the limit"});
    assert!(
        capped(20, &agent, input)
            .await
            .contains("would exceed maximum of 20 bytes")
    );
    assert_eq!(notebooks(&agent)["notes"], "Hello");

    let agent = with_notebooks(json!({"notes": "Hi"}));
    let input = json!({"mode": "write", "name": "notes", "oldStr": "Hi", "newStr": "A string that is too long"});
    assert!(
        capped(10, &agent, input)
            .await
            .contains("would exceed maximum of 10 bytes")
    );
}

#[tokio::test]
async fn does_not_apply_the_size_cap_for_clear_or_read() {
    let tool = make_notebook(MakeNotebookOptions::builder().max_notebook_size_bytes(1).build()).unwrap();
    let agent = with_notebooks(json!({"notes": "Much more than one byte"}));
    assert_eq!(
        ok_text(&tool, json!({"mode": "read", "name": "notes"}), &agent).await,
        "Much more than one byte"
    );
    assert_eq!(
        ok_text(&tool, json!({"mode": "clear", "name": "notes"}), &agent).await,
        "Cleared notebook 'notes'"
    );
}

#[tokio::test]
async fn allows_content_exactly_at_the_cap() {
    let tool = make_notebook(MakeNotebookOptions::builder().max_notebook_size_bytes(3).build()).unwrap();
    let input = json!({"mode": "create", "name": "nb", "newStr": "abc"});
    assert_eq!(
        ok_text(&tool, input, &with_notebooks(json!({}))).await,
        "Created notebook 'nb' with specified content"
    );
}

#[tokio::test]
async fn persists_state_only_after_mutating_modes() {
    let agent = with_notebooks(json!({"nb": "hello"}));
    ok(&agent, json!({"mode": "write", "name": "nb", "newStr": " world"})).await;
    assert_eq!(notebooks(&agent)["nb"], "hello\n world");
    ok(&agent, json!({"mode": "read", "name": "nb"})).await;
    assert_eq!(notebooks(&agent), json!({"nb": "hello\n world"}));

    let agent = with_notebooks(json!({}));
    assert!(ok(&agent, json!({"mode": "list"})).await.contains("default: Empty"));
    assert_eq!(notebooks(&agent), json!({}));
}
