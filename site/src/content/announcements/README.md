# Homepage banner

The homepage banner uses the newest published blog post by default. New blog posts
replace older banner content automatically on their publication date.

Add one YAML file per announcement when the banner should link to something other
than the latest blog post. The newest item wins. A manual announcement with the
same date as a blog post takes precedence as an explicit override.

A manual announcement is shown for 14 days from its `date`, then the banner
returns to the newest blog post. To keep it up after updating its content, bump
`date`. To pick a different last day, set `expires`.

```yaml
title: "Strands Decider 2B is here: a small, open source decision model from Strands Labs."
href: "/blog/introducing-strands-decider/" # site path or full URL
linkText: "Read the post" # optional, defaults to "Learn more"
date: 2026-10-01
expires: 2026-10-19 # optional, last day shown; defaults to 14 days from date
```

## When to add one

Add a manual announcement for content outside the blog, or when a campaign should
override a blog post:

1. Add a YAML file here, linking to the changelog, release notes, or blog post.
2. Set `date` to the launch day.
3. Deploy the site.

Future-dated blog posts stay out of production until their date in the
`America/New_York` time zone. Pull request previews include them for review. The
site continues to deploy manually, so a scheduled post appears on the first
production deployment on or after its publication date.
