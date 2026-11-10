#!/usr/bin/env bash
set -eo pipefail

# Usage: fetch-pr-feedback [PR_NUMBER] [--repo OWNER/REPO]
# If PR_NUMBER is omitted, auto-detects from current branch.
# Outputs all unresolved feedback as JSON to stdout.

REPO_FLAG=()
PR_NUMBER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO_FLAG=(--repo "$2"); shift 2 ;;
    *) PR_NUMBER="$1"; shift ;;
  esac
done

if [[ -z "$PR_NUMBER" ]]; then
  PR_NUMBER=$(gh pr view "${REPO_FLAG[@]}" --json number -q .number 2>/dev/null) || {
    echo "ERROR: Could not detect PR number. Pass it as an argument." >&2
    exit 1
  }
fi

OWNER_REPO=$(gh pr view "$PR_NUMBER" "${REPO_FLAG[@]}" --json url -q '.url' \
  | sed -E 's|https://github.com/([^/]+/[^/]+)/pull/.*|\1|')

OWNER=$(echo "$OWNER_REPO" | cut -d/ -f1)
REPO=$(echo "$OWNER_REPO" | cut -d/ -f2)

echo "{"

# Reviews (top-level review summaries, excluding empty-body reviews)
echo "\"reviews\":"
gh pr view "$PR_NUMBER" "${REPO_FLAG[@]}" --json reviews \
  --jq '[.reviews[] | select(.body != "") | {id: .id, author: .author.login, state: .state, body: .body, createdAt: .submittedAt}]'
echo ","

# Inline comments — only unresolved threads via GraphQL, with outdated flag and reactions
echo "\"inline_comments\":"
gh api graphql -f query="
{
  repository(owner: \"${OWNER}\", name: \"${REPO}\") {
    pullRequest(number: ${PR_NUMBER}) {
      reviewThreads(first: 100) {
        nodes {
          isResolved
          isOutdated
          comments(first: 100) {
            nodes {
              id
              path
              line
              originalLine
              body
              diffHunk
              createdAt
              author { login }
              reactions(first: 10) {
                nodes {
                  content
                  user { login }
                }
              }
            }
          }
        }
      }
    }
  }
}" --jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not) | . as $thread | .comments.nodes[0] as $first | .comments.nodes[] | {id: .id, path: .path, line: (.line // .originalLine), body: .body, user: .author.login, outdated: $thread.isOutdated, createdAt: .createdAt, upvotes: [.reactions.nodes[] | select(.content == "THUMBS_UP") | .user.login], downvotes: [.reactions.nodes[] | select(.content == "THUMBS_DOWN") | .user.login]} + (if .id == $first.id then {diffHunk: $first.diffHunk} else {} end)]'
echo ","

# Issue-level comments
echo "\"comments\":"
gh pr view "$PR_NUMBER" "${REPO_FLAG[@]}" --json comments \
  --jq '[.comments[] | {author: .author.login, body: .body, createdAt: .createdAt}]'

echo "}"
