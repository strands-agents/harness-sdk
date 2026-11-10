# Pull Request Description Guidelines

Good PR descriptions help reviewers understand the context and impact of your changes. They enable faster reviews, better decision-making, and serve as valuable historical documentation.

When creating a PR, follow the [GitHub PR template](../.github/PULL_REQUEST_TEMPLATE.md) and use these guidelines to fill it out effectively.

## Who's Reading Your PR?

Write for senior engineers familiar with the SDK. Assume your reader:

- Understands the SDK's architecture and patterns
- Has context about the broader system
- Can read code diffs to understand implementation details
- Values concise, focused communication

## What to Include

Every PR description should have:

1. **Motivation** — Why is this change needed?
2. **Public API Changes** — What changes to the public API (with code snippets)? Only include when introducing or modifying public API surface.
3. **Use Cases** (optional) — When would developers use this feature? Only include for non-obvious functionality; skip for trivial changes or obvious fixes.
4. **Breaking Changes** (if applicable) — What breaks and how to migrate?

## Writing Principles

**Focus on WHY, not HOW:**

- "Hook providers need access to the agent's result to perform post-invocation actions like logging or analytics"
- Not: "Added result field to AfterInvocationEvent dataclass"

**Document public API changes with example code snippets:**

- Show before/after code snippets for API changes
- Not: List every file or line changed

**Be concise:**

- Use prose over bullet lists when possible
- Not: Create exhaustive implementation checklists

**Emphasize user impact:**

- "Enables hooks to log conversation outcomes or trigger follow-up actions based on the result"
- Not: "Updated AfterInvocationEvent to include optional AgentResult field"

## What to Skip

Leave these out of your PR description:

- **Implementation details** — Code comments and commit messages cover this
- **Test coverage notes** — CI will catch issues; assume tests are comprehensive
- **Line-by-line change lists** — The diff provides this
- **Build/lint/coverage status** — CI handles verification
- **Commit hashes** — GitHub links commits automatically

## Anti-patterns

**Over-detailed checklists:**

```markdown
### Type Definition Updates

- Added result field to AfterInvocationEvent dataclass
- Updated Agent._run_loop to capture and pass AgentResult
```

**Implementation notes reviewers don't need:**

```markdown
## Implementation Notes

- Result field defaults to None
- AgentResult is captured from EventLoopStopEvent before invoking hooks
```

**Test coverage bullets:**

```markdown
### Test Coverage

- Added test: AfterInvocationEvent includes AgentResult
- Added test: result is None when structured_output is used
```

## Good Examples

**Motivation section:**

```markdown
## Motivation

Hook providers often need to perform actions based on the outcome of an agent's
invocation, such as logging results, updating metrics, or triggering follow-up
workflows. Currently, the `AfterInvocationEvent` doesn't provide access to the
`AgentResult`, forcing hook implementations to track state externally or miss
this information entirely.
```

**Public API Changes section:**

````markdown
## Public API Changes

`AfterInvocationEvent` now includes an optional `result` attribute containing
the `AgentResult`:

```python
# Before: no access to result
class MyHook(HookProvider):
    def on_after_invocation(self, event: AfterInvocationEvent) -> None:
        # Could only access event.agent, no result available
        logger.info("Invocation completed")

# After: result available for inspection
class MyHook(HookProvider):
    def on_after_invocation(self, event: AfterInvocationEvent) -> None:
        if event.result:
            logger.info(f"Completed with stop_reason: {event.result.stop_reason}")
```

The `result` field is `None` when invoked from `structured_output` methods.
````

**Use Cases section:**

```markdown
## Use Cases

- **Result logging**: Log conversation outcomes including stop reasons and token usage
- **Analytics**: Track agent performance metrics based on invocation results
- **Conditional workflows**: Trigger follow-up actions based on how the agent completed
```

## Template

````markdown
## Motivation

[Explain WHY this change is needed. What problem does it solve? What limitation
does it address? What user need does it fulfill?]

Resolves: #[issue-number]

## Public API Changes

[Document changes to public APIs with before/after code snippets. If no public
API changes, omit this section entirely.]

```python
# Before
[existing API usage]

# After
[new API usage]
```

[Explain behavior, parameters, return values, and backward compatibility.]

## Use Cases (optional)

[Only include for non-obvious functionality. Provide 1-3 concrete use cases
showing when developers would use this feature. Skip for trivial changes or obvious fixes.]

## Breaking Changes (if applicable)

[If this is a breaking change, explain what breaks and provide migration guidance.]

### Migration

```python
# Before
[old code]

# After
[new code]
```

````

## Why These Guidelines?

**Focus on WHY over HOW** because code diffs show implementation details, commit messages document granular changes, and PR descriptions provide the broader context reviewers need.

**Skip test/lint/coverage details** because CI pipelines verify these automatically. Including them adds noise without value.

**Write for senior engineers** to enable concise, technical communication without redundant explanations.

## References

- [Conventional Commits](https://www.conventionalcommits.org/)
- [Google's Code Review Guidelines](https://google.github.io/eng-practices/review/)

## Checklist Items

 - [ ] Does the PR description target a Senior Engineer familiar with the project?
 - [ ] Does the PR description give an overview of the feature being implemented, including any notes on key implementation decisions?
 - [ ] Does the PR include a "Resolves #<ISSUE NUMBER>" in the body and is not bolded?
 - [ ] Does the PR contain the motivation or use-cases behind the change?
 - [ ] Does the PR omit irrelevant details not needed for historical reference?
