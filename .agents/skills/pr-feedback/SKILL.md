---
name: pr-feedback
description: Fetches PR review feedback and inline comments, categorizes them, and presents options to the user. Use when the user asks to get, read, address, or fix review comments on a pull request.
---

# PR Review Feedback

Fetch PR review feedback and inline comments, categorize them, and present options to fix.

## Process

### 1. Determine the PR Number

Auto-detect from the current branch:

```bash
gh pr view --json number -q .number
```

If that fails (detached HEAD, no tracking branch), ask the user for the PR number or URL.

### 2. Fetch All Feedback

Use the bundled script to fetch reviews, inline comments, and issue-level comments in one shot:

```bash
bash .agents/skills/pr-feedback/fetch-pr-feedback.sh <number> [--repo owner/repo]
```

- Omit `<number>` to auto-detect from the current branch.
- Use `--repo` when the PR is in a different repo than the current directory.

The script returns JSON with three arrays:
- `reviews` — top-level review summaries (non-empty bodies only)
- `inline_comments` — unresolved thread comments with `upvotes`/`downvotes` arrays (usernames who reacted), `outdated` flag, and `diffHunk` on the first comment in each thread
- `comments` — issue-level comments

### 3. Summarize and Present to the User

Read all the feedback, use your judgment to group related items, and present a numbered list of things to address. Keep each item to one line. Put the most impactful items first.

Use upvotes, downvotes, and the PR author's own replies to determine priority:

- **Upvoted by the PR author**: This signals agreement — recommend fixing it.
- **Author replied agreeing** (e.g. "good point", "I'll fix", "makes sense"): Same as an upvote — recommend fixing it.
- **Upvoted by other reviewers** (not the author): Signals community agreement the issue matters — lean toward recommending.
- **No signal from the author**: Present as a suggestion but don't assume it should be fixed.
- **Author replied disagreeing or explaining**: Present for context but mark as "discussed — likely skip".
- **Outdated comments**: Group separately at the end — these may have been addressed by subsequent pushes.

When presenting the list, annotate items you recommend fixing (based on the signals above) so the user can quickly confirm "all recommended" or cherry-pick.

### 4. Fix What the User Selects

Address only the confirmed items. After fixing, briefly note what changed — one line per item.

## Rules

- Always auto-detect the PR number before asking the user.
- Never fix anything before presenting the list and getting user confirmation.
- If the output is too large to parse in one shot, focus on non-outdated comments first.
