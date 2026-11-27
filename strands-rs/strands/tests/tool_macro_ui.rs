//! Compile errors of `#[tool]` and `#[tools]`, checked against the `.stderr` snapshots in
//! `tests/ui/`. Regenerate them with `TRYBUILD=overwrite cargo test -p strands --all-features --test tool_macro_ui`.

#[test]
fn reports_unsupported_tool_signatures() {
    trybuild::TestCases::new().compile_fail("tests/ui/*.rs");
}

/// rustc writes the `BoxError` bound of these errors with paths that depend on the enabled
/// features (`Sync` or `std::marker::Sync`), so their snapshots are taken with all features.
#[cfg(all(
    feature = "bedrock",
    feature = "anthropic",
    feature = "openai",
    feature = "mcp",
    feature = "otel"
))]
#[test]
fn reports_error_types_that_do_not_convert() {
    trybuild::TestCases::new().compile_fail("tests/ui/all_features/*.rs");
}
