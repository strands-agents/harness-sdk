use std::sync::Arc;

use super::*;
use crate::Error;
use crate::test_support::MockTool;

fn tool(name: &str) -> Arc<dyn Tool> {
    Arc::new(MockTool::new(name))
}

fn names(registry: &ToolRegistry) -> Vec<String> {
    registry.list().iter().map(|tool| tool.name().to_owned()).collect()
}

fn add_error(registry: &mut ToolRegistry, tool: Arc<dyn Tool>) -> String {
    let error = registry.add(tool).unwrap_err();
    assert!(matches!(error, Error::ToolValidation(_)), "{error:?}");
    error.to_string()
}

#[test]
fn registers_a_single_tool() {
    let mut registry = ToolRegistry::new();
    let tool = tool("valid-tool");
    registry.add(tool.clone()).unwrap();
    assert!(Arc::ptr_eq(&registry.list()[0], &tool));
}

#[test]
fn registers_an_array_of_tools() {
    let mut registry = ToolRegistry::new();
    registry.add(vec![tool("tool-1"), tool("tool-2")]).unwrap();
    assert_eq!(names(&registry), ["tool-1", "tool-2"]);
}

#[test]
fn throws_tool_validation_error_for_a_duplicate_tool_name() {
    let mut registry = ToolRegistry::new();
    registry.add(tool("duplicate")).unwrap();
    assert_eq!(
        add_error(&mut registry, tool("duplicate")),
        "Tool with name 'duplicate' already registered"
    );
}

#[test]
fn throws_tool_validation_error_when_a_name_differs_only_by_dash_vs_underscore() {
    let mut registry = ToolRegistry::new();
    registry.add(tool("foo-bar")).unwrap();
    assert_eq!(
        add_error(&mut registry, tool("foo_bar")),
        "Tool name 'foo_bar' already exists as 'foo-bar'. Cannot add a duplicate tool which differs by a '-' or '_'"
    );
}

#[test]
fn throws_tool_validation_error_for_an_invalid_tool_name_pattern() {
    assert_eq!(
        add_error(&mut ToolRegistry::new(), tool("invalid name!")),
        "tool_name=<invalid name!> | Tool name must contain only alphanumeric characters, hyphens, and underscores"
    );
}

#[test]
fn throws_tool_validation_error_for_a_tool_name_that_is_too_long() {
    assert_eq!(
        add_error(&mut ToolRegistry::new(), tool(&"a".repeat(65))),
        format!(
            "tool_name=<{}> | Tool name must be between 1 and 64 characters",
            "a".repeat(65)
        )
    );
}

#[test]
fn throws_tool_validation_error_for_a_tool_name_that_is_too_short() {
    assert_eq!(
        add_error(&mut ToolRegistry::new(), tool("")),
        "tool_name=<> | Tool name must be between 1 and 64 characters"
    );
}

#[test]
fn throws_tool_validation_error_for_an_empty_string_description() {
    let tool = Arc::new(MockTool::new("tool-1").with_description(""));
    assert_eq!(
        add_error(&mut ToolRegistry::new(), tool),
        "tool_name=<tool-1> | Tool description must be a non-empty string"
    );
}

#[test]
fn registers_a_tool_with_a_name_at_the_maximum_length() {
    ToolRegistry::new().add(tool(&"a".repeat(64))).unwrap();
}

#[test]
fn keeps_tools_before_a_failing_one() {
    let mut registry = ToolRegistry::new();
    assert!(registry.add(vec![tool("tool-1"), tool("bad name")]).is_err());
    assert_eq!(names(&registry), ["tool-1"]);
}

#[test]
fn add_or_replace_registers_tools() {
    let mut registry = ToolRegistry::new();
    let tool = tool("tool-1");
    registry.add_or_replace(vec![tool.clone()]).unwrap();
    assert!(Arc::ptr_eq(registry.get("tool-1").unwrap(), &tool));
}

#[test]
fn replaces_an_existing_tool_with_the_same_name() {
    let mut registry = ToolRegistry::new();
    registry.add(tool("tool-1")).unwrap();
    let replacement: Arc<dyn Tool> = Arc::new(MockTool::new("tool-1").with_description("replacement"));
    registry.add_or_replace(vec![replacement.clone()]).unwrap();
    assert!(Arc::ptr_eq(registry.get("tool-1").unwrap(), &replacement));
}

#[test]
fn validates_tool_properties() {
    let error = ToolRegistry::new()
        .add_or_replace(vec![tool("invalid name!")])
        .unwrap_err();
    assert!(matches!(error, Error::ToolValidation(_)));
}

#[test]
fn throws_tool_validation_error_when_a_new_tool_name_differs_only_by_dash_vs_underscore() {
    let mut registry = ToolRegistry::new();
    registry.add(tool("foo-bar")).unwrap();
    let error = registry.add_or_replace(vec![tool("foo_bar")]).unwrap_err();
    assert!(matches!(error, Error::ToolValidation(_)));
}

fn ptr_eq_all(left: &[Arc<dyn Tool>], right: &[Arc<dyn Tool>]) -> bool {
    left.len() == right.len() && left.iter().zip(right).all(|(a, b)| Arc::ptr_eq(a, b))
}

#[test]
fn replaces_the_current_tools_with_the_next_ones_and_keeps_every_other_tool() {
    let mut registry = ToolRegistry::new();
    let other = tool("other");
    let (old_a, old_b) = (tool("tool-a"), tool("tool-b"));
    let (new_b, new_c) = (tool("tool-b"), tool("tool-c"));
    registry.add(vec![other.clone(), old_a.clone(), old_b.clone()]).unwrap();

    assert!(
        registry
            .swap(&[old_a, old_b], vec![new_b.clone(), new_c.clone()])
            .is_empty()
    );

    assert!(ptr_eq_all(&registry.list(), &[other, new_b, new_c]));
}

#[test]
fn skips_a_next_tool_that_fails_validation_and_registers_the_rest() {
    let cases = [
        ("other", "Tool with name 'other' already registered"),
        ("other_tool", "Tool name 'other_tool' already exists as 'other-tool'"),
        ("bad name!", "Tool name must contain only alphanumeric characters"),
    ];
    for (name, reason) in cases {
        let mut registry = ToolRegistry::new();
        let others = [tool("other"), tool("other-tool")];
        let current = tool("tool-a");
        let (kept, rejected) = (tool("tool-b"), tool(name));
        registry.add(others.to_vec()).unwrap();
        registry.add(current.clone()).unwrap();

        let skipped = registry.swap(&[current], vec![rejected.clone(), kept.clone()]);

        assert_eq!(skipped.len(), 1, "{name}");
        assert!(Arc::ptr_eq(&skipped[0].0, &rejected));
        assert!(skipped[0].1.to_string().contains(reason), "{}", skipped[0].1);
        assert!(ptr_eq_all(
            &registry.list(),
            &[others[0].clone(), others[1].clone(), kept]
        ));
    }
}

#[test]
fn skips_a_next_tool_whose_name_an_earlier_next_tool_took() {
    let mut registry = ToolRegistry::new();
    let (first, second) = (tool("tool-a"), tool("tool-a"));

    let skipped = registry.swap(&[], vec![first.clone(), second.clone()]);

    assert_eq!(skipped.len(), 1);
    assert!(Arc::ptr_eq(&skipped[0].0, &second));
    assert!(ptr_eq_all(&registry.list(), &[first]));
}

#[test]
fn leaves_a_tool_registered_under_a_current_name_by_another_source() {
    let mut registry = ToolRegistry::new();
    let other = tool("tool-a");
    registry.add(other.clone()).unwrap();

    registry.swap(&[tool("tool-a")], Vec::new());

    assert!(Arc::ptr_eq(registry.get("tool-a").unwrap(), &other));
}

#[test]
fn retrieves_a_tool_by_name() {
    let mut registry = ToolRegistry::new();
    let tool = tool("find-me");
    registry.add(tool.clone()).unwrap();
    assert!(Arc::ptr_eq(registry.get("find-me").unwrap(), &tool));
}

#[test]
fn returns_undefined_for_a_non_existent_tool() {
    assert!(ToolRegistry::new().get("non-existent").is_none());
}

#[test]
fn returns_the_tool_for_an_exact_name_match() {
    let registry = ToolRegistry::with_tools(tool("my-tool")).unwrap();
    assert_eq!(registry.resolve("my-tool").unwrap().name(), "my-tool");
}

#[test]
fn resolves_underscore_to_hyphen_substitution() {
    let registry = ToolRegistry::with_tools(tool("my-tool")).unwrap();
    assert_eq!(registry.resolve("my_tool").unwrap().name(), "my-tool");
}

#[test]
fn resolves_case_insensitively() {
    let registry = ToolRegistry::with_tools(tool("MyTool")).unwrap();
    assert_eq!(registry.resolve("mytool").unwrap().name(), "MyTool");
}

#[test]
fn prefers_exact_match_over_case_insensitive_match() {
    let exact = tool("mytool");
    let registry = ToolRegistry::with_tools(vec![exact.clone(), tool("MYTOOL")]).unwrap();
    assert!(Arc::ptr_eq(registry.resolve("mytool").unwrap(), &exact));
}

#[test]
fn prefers_exact_match_over_underscore_to_hyphen_match() {
    let registry = ToolRegistry::with_tools(tool("my_tool")).unwrap();
    assert_eq!(registry.resolve("my_tool").unwrap().name(), "my_tool");
}

#[test]
fn throws_tool_not_found_error_when_no_tool_matches() {
    let registry = ToolRegistry::with_tools(tool("existing-tool")).unwrap();
    assert!(matches!(registry.resolve("nonexistent"), Err(Error::ToolNotFound(_))));
}

#[test]
fn attaches_the_requested_name_to_the_thrown_tool_not_found_error() {
    let Err(Error::ToolNotFound(error)) = ToolRegistry::new().resolve("missing") else {
        panic!("expected ToolNotFoundError");
    };
    assert_eq!(error.tool_name, "missing");
    assert_eq!(error.to_string(), "Tool 'missing' not found");
}

#[test]
fn throws_tool_not_found_error_when_registry_is_empty() {
    assert!(matches!(
        ToolRegistry::new().resolve("anything"),
        Err(Error::ToolNotFound(_))
    ));
}

#[test]
fn removes_a_tool_by_name() {
    let mut registry = ToolRegistry::with_tools(tool("remove-me")).unwrap();
    registry.remove("remove-me");
    assert!(registry.get("remove-me").is_none());
}

#[test]
fn does_not_throw_when_removing_a_non_existent_tool() {
    ToolRegistry::new().remove("non-existent");
}

#[test]
fn returns_an_empty_array_when_no_tools_are_registered() {
    assert!(ToolRegistry::new().list().is_empty());
}

#[test]
fn returns_all_registered_tools() {
    let registry = ToolRegistry::with_tools(vec![tool("tool-1"), tool("tool-2")]).unwrap();
    assert_eq!(names(&registry), ["tool-1", "tool-2"]);
}

#[test]
fn should_remove_all_registered_tools() {
    let mut registry = ToolRegistry::with_tools(vec![tool("tool-1"), tool("tool-2")]).unwrap();
    registry.clear();
    assert!(registry.is_empty());
}

#[test]
fn should_be_a_no_op_on_an_empty_registry() {
    let mut registry = ToolRegistry::new();
    registry.clear();
    assert!(registry.list().is_empty());
}

#[test]
fn accepts_initial_tools() {
    let registry = ToolRegistry::with_tools(vec![tool("valid-tool")]).unwrap();
    assert_eq!(names(&registry), ["valid-tool"]);
}
