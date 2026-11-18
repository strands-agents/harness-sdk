# Homepage banner

The homepage banner uses the newest published blog post by default. New blog posts replace older banner content
automatically the next time the site builds.

Add one YAML file per announcement when the banner should link to something other than the latest blog post. Unless it
sets `expires`, the newest item wins. A manual announcement with the same date as a blog post takes precedence as an
explicit override.

A manual announcement is shown for 14 days from its `date`, then the banner returns to the newest blog post. To keep it
up after updating its content, bump `date`. Set `expires` to pin the announcement through a specific day; without it, a
newer blog post can replace the announcement before its default window ends.

```yaml
title: "Strands Decider 2B is here: a small, open source decision model from Strands Labs."
href: "/blog/introducing-strands-decider/" # site path or full URL
linkText: "Read the post" # optional, defaults to "Learn more"
date: 2026-10-01
expires: 2026-10-19 # optional, pins the announcement through this day
```

## When to add one

Add a manual announcement for content outside the blog, or when a campaign should override a blog post:

1. Add a YAML file here, linking to the changelog, release notes, or blog post.
2. Set `date` to the launch day.
3. Deploy the site.
