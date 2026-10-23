#!/usr/bin/env bash
# Close the open announcement discussions that a new release supersedes, so
# only the newest announcement per package stays open.
#
# A discussion is closed only when its title is a tag of the same package as
# NEW_TAG (`<package>/v<version>`, e.g. `python/v1.62.0`) and is not NEW_TAG
# itself. Nothing is closed unless the NEW_TAG announcement exists and is
# open, so a failed post never leaves a package without an open announcement.
#
# Environment:
#   GH_TOKEN             token with discussions: write
#   GITHUB_REPOSITORY    owner/name
#   NEW_TAG              the tag just announced
#   DISCUSSION_CATEGORY  category name; empty skips the cleanup (fork runs)
#   DRY_RUN              "true" lists what would be closed without closing it
# GraphQL variables ($owner, ...) are single-quoted on purpose.
# shellcheck disable=SC2016
set -euo pipefail

if [ -z "${DISCUSSION_CATEGORY:-}" ]; then
  echo "category=<empty> | skipping announcement cleanup"
  exit 0
fi

if [[ ! "$NEW_TAG" =~ ^([a-z][a-z0-9-]*)/v[0-9] ]]; then
  echo "::warning::tag=$NEW_TAG | not a <package>/v<version> tag, skipping announcement cleanup"
  exit 0
fi
package="${BASH_REMATCH[1]}"
owner="${GITHUB_REPOSITORY%%/*}"
repo="${GITHUB_REPOSITORY#*/}"

category_id=$(gh api graphql \
  -f owner="$owner" -f repo="$repo" \
  -f query='query($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      discussionCategories(first: 100) { nodes { id name } }
    }
  }' \
  --jq ".data.repository.discussionCategories.nodes[] | select(.name == \"$DISCUSSION_CATEGORY\") | .id")

if [ -z "$category_id" ]; then
  echo "::warning::category=$DISCUSSION_CATEGORY | category not found, skipping announcement cleanup"
  exit 0
fi

# One `<id>\t<number>\t<title>` line per open discussion in the category.
open_discussions=$(gh api graphql --paginate \
  -f owner="$owner" -f repo="$repo" -f categoryId="$category_id" \
  -f query='query($owner: String!, $repo: String!, $categoryId: ID!, $endCursor: String) {
    repository(owner: $owner, name: $repo) {
      discussions(first: 100, after: $endCursor, categoryId: $categoryId, states: OPEN) {
        nodes { id number title }
        pageInfo { hasNextPage endCursor }
      }
    }
  }' \
  --jq '.data.repository.discussions.nodes[] | [.id, (.number | tostring), .title] | @tsv')

if ! grep -qxF "$NEW_TAG" < <(cut -f3 <<< "$open_discussions"); then
  echo "::warning::tag=$NEW_TAG | no open announcement for this tag, skipping announcement cleanup"
  exit 0
fi

# Anchored on the package prefix and a version so unrelated announcements
# never match.
superseded_pattern="^${package}/v[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$"
closed=0
while IFS=$'\t' read -r id number title; do
  if [ -z "$id" ] || [ "$title" = "$NEW_TAG" ] || [[ ! "$title" =~ $superseded_pattern ]]; then
    continue
  fi
  if [ "${DRY_RUN:-}" = "true" ]; then
    echo "number=$number, title=$title | would close superseded announcement"
  else
    gh api graphql -f id="$id" \
      -f query='mutation($id: ID!) {
        closeDiscussion(input: {discussionId: $id, reason: OUTDATED}) { discussion { number } }
      }' >/dev/null
    echo "number=$number, title=$title | closed superseded announcement"
  fi
  closed=$((closed + 1))
done <<< "$open_discussions"

echo "tag=$NEW_TAG, superseded=$closed | announcement cleanup done"
