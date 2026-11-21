use super::*;

#[test]
fn appends_the_stash_ref_and_records_what_the_placeholder_stands_for() {
    assert_eq!(
        offload_placeholder(
            OffloadMethod::Drop,
            "[Dropped: earlier messages]",
            Some("removed-abc"),
            0
        ),
        TextBlock::offloaded(
            "[Dropped: earlier messages] [ref: removed-abc]",
            Offloaded::new(OffloadMethod::Drop).with_reference("removed-abc"),
        )
    );
}

#[test]
fn leaves_out_the_ref_when_the_original_was_not_stashed() {
    assert_eq!(
        offload_placeholder(OffloadMethod::Drop, "[Dropped]", None, 0),
        TextBlock::offloaded("[Dropped]", Offloaded::new(OffloadMethod::Drop))
    );
}

#[test]
fn formats_markers() {
    let cases = [
        (
            "a dropped block",
            format_dropped(2525, None),
            "[Dropped: ~2,525 tokens]",
        ),
        ("an unmeasured dropped block", format_dropped(0, None), "[Dropped]"),
        (
            "dropped media",
            format_dropped(2525, Some("image")),
            "[Dropped: image, ~2,525 tokens, removed from context after it was received]",
        ),
        (
            "unmeasured dropped media",
            format_dropped(0, Some("image")),
            "[Dropped: image, removed from context after it was received]",
        ),
        (
            "dropped messages",
            format_dropped_messages(1200),
            "[Dropped: earlier messages, ~1,200 tokens]",
        ),
        (
            "unmeasured dropped messages",
            format_dropped_messages(0),
            "[Dropped: earlier messages]",
        ),
        (
            "an offloaded block",
            format_offloaded(2525, None),
            "[Offloaded: ~2,525 tokens]",
        ),
        ("an unmeasured block", format_offloaded(0, None), "[Offloaded]"),
        (
            "offloaded media",
            format_offloaded(2525, Some("document")),
            "[Offloaded: document, ~2,525 tokens, removed from context after it was received]",
        ),
        (
            "unmeasured media",
            format_offloaded(0, Some("image")),
            "[Offloaded: image, removed from context after it was received]",
        ),
        (
            "a summary",
            format_summarized("tool result", 2525, Some("short")),
            "[Summarized: tool result, ~2,525 tokens]\n\nshort",
        ),
        (
            "an unmeasured summary",
            format_summarized("media block", 0, Some("a red square")),
            "[Summarized: media block]\n\na red square",
        ),
        (
            "a truncated block",
            format_truncated(1, 7500, "head"),
            "[Truncated: 1 block, ~7,500 tokens]\n\nhead",
        ),
        (
            "truncated blocks",
            format_truncated(2, 7500, "head"),
            "[Truncated: 2 blocks, ~7,500 tokens]\n\nhead",
        ),
        (
            "elided messages",
            format_elided(1200),
            "[... earlier messages elided, ~1,200 tokens ...]",
        ),
        (
            "unmeasured elided messages",
            format_elided(0),
            "[... earlier messages elided ...]",
        ),
    ];
    for (case, text, expected) in cases {
        assert_eq!(text, expected, "{case}");
    }
}
