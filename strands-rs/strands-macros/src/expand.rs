//! The `Tool` implementation both macros generate.

use proc_macro2::TokenStream;
use quote::{quote, quote_spanned};
use syn::Path;

use crate::signature::{Param, ToolSignature};

/// One tool to generate.
pub(crate) struct ToolDef<'a> {
    pub(crate) krate: &'a Path,
    pub(crate) name: &'a str,
    pub(crate) description: &'a str,
    pub(crate) signature: &'a ToolSignature,
    /// The type that implements `Tool`.
    pub(crate) tool_type: TokenStream,
    /// What is called with the arguments: the function, or a method on the captured receiver.
    pub(crate) callee: TokenStream,
    /// Statements that run in `stream` before the tool future is created.
    pub(crate) setup: TokenStream,
}

/// The input struct, the cached schema and the `Tool` impl. They go inside an anonymous `const`
/// block, so the helper names never clash with user items.
pub(crate) fn tool_items(def: &ToolDef<'_>) -> TokenStream {
    let krate = def.krate;
    let private = quote!(#krate::__private);
    let has_input = def.signature.inputs().next().is_some();
    let input_struct = has_input.then(|| input_struct(def));
    let schema = if has_input {
        quote!(#private::ToolSchema::of::<__StrandsToolInput>)
    } else {
        quote!(#private::ToolSchema::empty)
    };
    let parse = has_input.then(|| {
        quote! {
            let __strands_input: __StrandsToolInput = match __strands_tool_schema().parse(&__strands_context) {
                ::core::result::Result::Ok(input) => input,
                ::core::result::Result::Err(error) => return error.into_outcome(__strands_tool_use_id),
            };
        }
    });
    let args = def.signature.params.iter().map(|param| match param {
        Param::Context => quote!(&__strands_context),
        Param::Input(input) => {
            let ident = &input.ident;
            quote!(__strands_input.#ident)
        }
    });
    let unwrap_result = def.signature.result.map(|span| {
        let into_error =
            quote_spanned!(span=> (&&#private::ErrorShape(&error)).strands_error_kind().into_tool_error(error));
        quote! {
            let __strands_output = match __strands_output {
                ::core::result::Result::Ok(output) => output,
                ::core::result::Result::Err(error) => return #into_error.into_outcome(__strands_tool_use_id),
            };
        }
    });
    let shape = quote_spanned!(def.signature.output_span=> (&&#private::Shape(&__strands_output)).strands_kind());
    let ToolDef {
        name,
        description,
        tool_type,
        callee,
        setup,
        ..
    } = def;
    quote! {
        #input_struct

        fn __strands_tool_schema() -> &'static #private::ToolSchema {
            static SCHEMA: #private::LazyLock<#private::ToolSchema> = #private::LazyLock::new(#schema);
            &SCHEMA
        }

        impl #krate::Tool for #tool_type {
            fn name(&self) -> &str {
                #name
            }

            fn description(&self) -> &str {
                #description
            }

            fn tool_spec(&self) -> #krate::ToolSpec {
                __strands_tool_schema().spec(#name, #description)
            }

            fn stream(&self, __strands_context: #krate::ToolContext) -> #krate::tools::ToolStream {
                #setup
                #krate::tools::ToolStream::from_future(async move {
                    #[allow(unused_imports)]
                    use #private::{
                        BlockShape as _, BoxErrorShape as _, ContentShape as _, ToolErrorShape as _, ValueShape as _,
                    };
                    let __strands_tool_use_id = ::std::string::String::clone(&__strands_context.tool_use().tool_use_id);
                    #parse
                    let __strands_output = #callee(#(#args),*).await;
                    #unwrap_result
                    let __strands_kind = #shape;
                    __strands_kind.outcome(__strands_output, __strands_tool_use_id)
                })
            }
        }
    }
}

fn input_struct(def: &ToolDef<'_>) -> TokenStream {
    let serde_path = format!("{}::__private::serde", path_string(def.krate));
    let schemars_path = format!("{}::__private::schemars", path_string(def.krate));
    let krate = def.krate;
    let fields = def.signature.inputs().map(|input| {
        let (attrs, ident, ty) = (&input.attrs, &input.ident, &input.ty);
        quote!(#(#attrs)* #ident: #ty)
    });
    quote! {
        #[derive(#krate::__private::serde::Deserialize, #krate::__private::schemars::JsonSchema)]
        #[serde(crate = #serde_path)]
        #[schemars(crate = #schemars_path, deny_unknown_fields)]
        struct __StrandsToolInput {
            #(#fields,)*
        }
    }
}

fn path_string(path: &Path) -> String {
    let segments: Vec<String> = path.segments.iter().map(|segment| segment.ident.to_string()).collect();
    let prefix = if path.leading_colon.is_some() { "::" } else { "" };
    format!("{prefix}{}", segments.join("::"))
}
