# Announcements

One YAML file per announcement. The most recent active one renders as the banner at the top of the homepage.

An announcement is shown for 14 days from its `date`, then hides automatically (at build time and, between deploys, in the browser). To keep it up after updating its content, bump `date`. To pick a different last day, set `expires`.

```yaml
title: "Strands Decider 2B is here: a small, open source decision model from Strands Labs."
href: "/blog/introducing-strands-decider/" # site path or full URL
linkText: "Read the post" # optional, defaults to "Learn more"
date: 2026-10-01
expires: 2026-10-19 # optional, last day shown; defaults to 14 days from date
```

## When to add one

On each release or feature worth calling out (product launches, notable features such as bidirectional streaming, and Labs projects):

1. Add a YAML file here, linking to the changelog, release notes, or blog post.
2. Set `date` to the launch day.
3. Deploy the site.
