//! Attribute arguments, parsed with darling.

use darling::FromMeta;
use darling::ast::NestedMeta;
use darling::util::Flag;
use proc_macro2::TokenStream;
use syn::{Attribute, LitStr, Meta, Path};

/// `#[tool(name = "..", description = "..", crate = "..")]`.
#[derive(Debug, Default, FromMeta)]
pub(crate) struct ToolArgs {
    pub(crate) name: Option<LitStr>,
    pub(crate) description: Option<LitStr>,
    #[darling(rename = "crate")]
    pub(crate) krate: Option<Path>,
}

/// `#[tools(crate = "..")]`.
#[derive(Debug, Default, FromMeta)]
pub(crate) struct ToolsArgs {
    #[darling(rename = "crate")]
    pub(crate) krate: Option<Path>,
}

/// `#[tool(context)]` on a parameter.
#[derive(Debug, Default, FromMeta)]
struct ParamArgs {
    context: Flag,
}

/// Parses the arguments of an attribute macro invocation.
pub(crate) fn parse_args<T: FromMeta>(tokens: TokenStream) -> darling::Result<T> {
    let items = NestedMeta::parse_meta_list(tokens)?;
    T::from_list(&items)
}

/// Parses a `#[tool]` or `#[tool(..)]` attribute written on an item inside `#[tools]`.
pub(crate) fn parse_attr<T: FromMeta + Default>(attr: &Attribute) -> darling::Result<T> {
    match &attr.meta {
        Meta::Path(_) => Ok(T::default()),
        Meta::List(list) => parse_args(list.tokens.clone()),
        Meta::NameValue(_) => T::from_meta(&attr.meta),
    }
}

/// Checks that a `#[tool(..)]` attribute on a parameter is `#[tool(context)]`.
pub(crate) fn check_context_attr(attr: &Attribute) -> syn::Result<()> {
    let expected = || syn::Error::new_spanned(attr, "expected `#[tool(context)]` on a `&ToolContext` parameter");
    let Meta::List(list) = &attr.meta else {
        return Err(expected());
    };
    let args: ParamArgs = parse_args(list.tokens.clone()).map_err(syn::Error::from)?;
    if !args.context.is_present() {
        return Err(expected());
    }
    Ok(())
}

/// Whether `attr` is a `#[tool]` attribute, written `tool` or with a path ending in `tool`.
pub(crate) fn is_tool_attr(attr: &Attribute) -> bool {
    attr.path()
        .segments
        .last()
        .is_some_and(|segment| segment.ident == "tool")
}

/// The default crate path, `::strands`.
pub(crate) fn default_crate() -> Path {
    syn::parse_quote!(::strands)
}
