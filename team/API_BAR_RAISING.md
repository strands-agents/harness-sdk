# API Bar Raising

## Introduction

API Bar-Raising is a mechanism intended to ensure the SDK maintains a high-quality, consistent, and future-proof API surface across the SDK when developing new features, while conforming to our expectations and [tenets for the SDK](./TENETS.md). It **is** intended to act as a quality gate while attempting to minimize the friction of integrating new features into the SDK.

The process focuses exclusively on public API design and customer-facing contracts—not implementation details or internal/private APIs.

## Roles

API Bar-raising involves two roles:

- **API Proposer**: The engineer developing or proposing a new feature or API. Responsible for documenting use cases, providing example code, and preparing materials for review.
- **API reviewer**: A critical reviewer focused on evaluating the public API from a customer perspective. This is not a formal team role—any engineer with several years of API development experience can serve as an API reviewer. API reviewers should follow the process outlined in "API Reviewer Role" below.

## Timeline

API Bar-raising must be completed before merging a new feature or updating an existing one into the SDK. The appropriate level of review depends on the scope of change:

- **Minimal changes** — PR review is sufficient; no explicit API reviewer designation needed
  - *Example*: Adding a new parameter to an infrequently used method, or a new overload to tweak existing behavior
- **Moderate changes** — Informal discussion with an API reviewer, followed by standard PR review
  - *Example*: Adding a new class that customers use to achieve new behavior
- **Substantial changes** — Explicit meeting with API reviewers (at least 2 is desired) during or after the design phase
  - *Example*: Adding a new primitive or introducing a new abstraction that customers are expected to frequently use
  - *Note*: For larger features, incorporate bar-raising early in the design process, though a final review will still be required before merge

## Process

### API Reviewer Role

The API reviewer focuses exclusively on customer usage and the public API—not implementation details. Your role is to be a bit adversarial and take a critical eye towards the decisions made - you should actively challenge assumptions, identify gaps in use-case coverage, and ensure the API aligns with SDK tenets.

**Key questions to ask:**

- Does it conform to the [SDK tenets](./TENETS.md)?
- Does it conform to the [Decision Records](./DECISIONS.md)?
- If extensibility is a goal:
  - What is customizable and what is not?
  - Is it the proper level of abstraction?
- What use cases are not addressed and why?
- Are the default parameters/behavior the most common?
  - If not, why did we choose them?

If an API review session yields a decision that can guide future API designs, document it as a decision record. This is a sign of successful bar-raising.

### API Proposer Role

The API Proposer is responsible for preparing comprehensive documentation and examples that enable effective bar-raising discussions. Your goal is to provide the API reviewer with everything needed to evaluate the API from a customer perspective without requiring deep implementation knowledge.

**Required preparation:**

- Document expected use cases for the new feature
- Provide example code snippets that satisfy those use cases

**For streamlined discussions, prepare:**

- Complete API signatures (including default parameter values)
- End-to-end example usage from the customer's perspective
  - Include module imports
  - Include integration scenarios with existing functionality (if relevant)
- Module exports (what's exported from each module)

In any PRs for the feature, include the above information in the PR description for future reference.

### Designating an API Reviewer

The process for designating an API reviewer depends on the scope and stage of your feature development. 

For **standard PR reviews**, identify an engineer with API development experience to serve as your API reviewer. They should review the proposal from the API Reviewer Role perspective—focusing on customer usage and public API design rather than diving into implementation details. With proper preparation, the API reviewer should be able to understand and evaluate your proposal entirely from the PR description, making the review efficient and focused.

To indicate that a PR requires API review, add the `api/needs-review` label. Once the API reviewer has completed their evaluation and any necessary changes have been addressed, add the `api/review-complete` label. A CI check enforces that PRs with `api/needs-review` cannot be merged without `api/review-complete`. This makes it easy to track which PRs are awaiting review and which have been approved from an API perspective.

For **larger features** that require more extensive discussion, schedule a meeting with your designated API reviewer to walk through use cases and API design decisions. These sessions can be formal or informal depending on feature complexity. Individual or medium-sized features can take 30-60 minutes of discussion, while larger features may benefit from multiple sessions throughout the design and implementation phases. The goal is to catch potential issues early while maintaining fast iterations on feature development.

Alternatively, **team consensus** can be used in lieu of a designated API reviewer. This approach works well when broad alignment is needed or when the API introduces patterns the whole team will build upon - for example, the BiDirectional agents API benefited from team-wide discussion. However, use team consensus judiciously for APIs where the investment is justified, as a 30-minute meeting with 10 people represents 5 hours of collective effort.
