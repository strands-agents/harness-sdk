## Integration submission

<!-- This template is for adding or updating an entry on the integrations page at strandsagents.com/integrations.
     Full submission guide and YAML field reference: https://strandsagents.com/docs/integrations/get-featured/
     The site build validates your YAML against the schema automatically — a CI failure here is a schema error in your entry file. -->

**Package name:**
**Integration type:** <!-- tool | model-provider | session-manager | memory-store | storage | integration | plugin | observability | agent-extension | intervention -->
**Languages published:** <!-- Python / TypeScript — at least one required -->
**GitHub repo:** <!-- source of truth for the maintainer shown on your card (the URL's owner/org) -->
**What it does:** <!-- 1–2 sentences -->
**Relationship to service:** <!-- official vendor integration / community-built -->
**Docs link included:** <!-- docsUrl (link to your own docs) / none — card will link to GitHub repo. New submissions should not add on-site docs pages. -->

### Submitter checklist

#### Package
- [ ] This is a reusable integration (library/plugin/provider), not an example agent or application built with Strands
- [ ] Published to PyPI and/or npm under the exact `package` name in my entry (registry links are derived from it) — or this is a guide-only entry (no `package` in any language block) with a `docsUrl` pointing at the vendor's Strands guide
- [ ] GitHub repository is public and includes a license

#### Entry
- [ ] Description accurately states what the package does in one sentence
- [ ] `integrationType` matches what the package actually is
- [ ] All URLs are working (`github`, and `docsUrl` if set)
- [ ] `addedDate` is set to today (the date I opened this PR)
- [ ] `featured` and `badges` are left unset — those are granted by the Strands team

#### Docs (only if setting a `docsUrl`)
- [ ] The linked page documents using this integration with Strands Agents

#### Conduct
- [ ] I am the package maintainer, or I have the maintainer's explicit consent to list it
- [ ] Entry uses the package's real name with no trademark misuse

---

### For reviewers

- Package installs cleanly and imports without error against the current SDK release (guide-only entries: the `docsUrl` guide's setup steps work instead)
- Description matches what the package's README says it does
- No existing catalog entry for this package (`site/src/content/catalog/`)
- All URLs are reachable and resolve to the expected destinations
- `addedDate` matches the submission date and `featured`/`badges` are unset (CI labels the PR `catalog: editorial-review` if a non-maintainer sets them)
- The `docsUrl` page (if set) is a real Strands integration guide, not a generic product page
