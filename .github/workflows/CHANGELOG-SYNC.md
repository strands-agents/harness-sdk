# Changelog Sync — operations

`changelog-sync.yml` keeps `site/src/content/changelog/**` current. Every run
generates the files still missing from main for harness-sdk, evals, and box,
and opens or updates one rolling data-only PR (branch `changelog/sync` on the
`strands-agent` bot fork). Release workflows dispatch it directly after
creating a GitHub release (a `GITHUB_TOKEN`-created release does not emit a
`release` event), and a cron backstops every 2 hours.

## Release process

1. Run the release workflow.
2. Merge the open `docs(changelog): sync release notes` PR.
3. Run `Docs: Deploy to GitHub Pages`. It fails while any published release
   has no changelog file on main, so step 2 cannot be skipped by accident.

## CHANGELOG_BOT_TOKEN (repo secret)

A classic PAT on the **`strands-agent`** account (singular -- the dedicated bot
account, not the `strands-agents` org). Required scopes:

| Scope | Why |
|---|---|
| `public_repo` | Read releases/PRs, push branches to the bot's fork, open cross-repo PRs against this repo. |
| `workflow` | Any fork operation that carries `.github/workflows/*` changes -- both the fork `merge-upstream` sync step and PR-branch pushes -- is rejected with HTTP 422 without it. Upstream workflow files change routinely, so this scope is load-bearing, not optional. |

**When rotating the token, check both boxes.** A token with only
`public_repo` works until the next time any upstream workflow file changes,
then every scheduled run fails with:

```
refusing to allow a Personal Access Token to create or update workflow
`.github/workflows/changelog-sync.yml` without `workflow` scope (HTTP 422)
```

## Why a bot fork + PAT (not GITHUB_TOKEN)

PRs authored by `GITHUB_TOKEN` do not trigger `pull_request` workflows, so the
required CI Gate would never run on sync PRs. The bot is a real user account
pushing to its own fork (`strands-agent/harness-sdk`) and opening cross-repo
PRs; it has no write access to this repo.

## Recovery

- **Fork drifted / 422 on push**: the `Sync bot fork with upstream` step
  self-heals on the next run (given the `workflow` scope). Manual fix: the
  "Sync fork" button on the fork, or
  `gh api repos/strands-agent/harness-sdk/merge-upstream -f branch=main`.
- **Missed release**: dispatch `Changelog: Sync`, or wait for the cron
  backstop (every 2 hours at :17).
- **Re-render a synced release**: dispatch `Changelog: Sync` with its tag.
  Curated `highlights:` are preserved.
- **Urgent docs fix with a sync PR still pending**: run the docs deploy with
  `skip_changelog_check` checked.
