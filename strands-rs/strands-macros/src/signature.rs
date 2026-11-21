//! Checks a tool function's signature and splits its parameters into the context and the input.

use proc_macro2::Span;
use syn::spanned::Spanned;
use syn::visit::Visit;
use syn::{Attribute, FnArg, Ident, Pat, PatType, ReceiverKind, ReturnType, Safety, Signature, Type};

use crate::attrs::{check_context_attr, is_tool_attr};

/// Whether the function is a free function or a method of a `#[tools]` impl block.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FnKind {
    Free,
    Method,
}

/// One parameter, in declaration order.
pub(crate) enum Param {
    /// The `#[tool(context)]` parameter.
    Context,
    /// A field of the input struct.
    Input(Box<InputParam>),
}

/// A parameter that is part of the input schema.
pub(crate) struct InputParam {
    pub(crate) ident: Ident,
    pub(crate) ty: Type,
    /// Doc comments and `#[serde]`/`#[schemars]` attributes, moved to the input struct field.
    pub(crate) attrs: Vec<Attribute>,
}

/// The analyzed signature.
pub(crate) struct ToolSignature {
    pub(crate) params: Vec<Param>,
    /// The span of the return type when it is a `Result`.
    pub(crate) result: Option<Span>,
    /// The span of the return type, or of the signature when there is none.
    pub(crate) output_span: Span,
}

impl ToolSignature {
    pub(crate) fn inputs(&self) -> impl Iterator<Item = &InputParam> {
        self.params.iter().filter_map(|param| match param {
            Param::Input(input) => Some(&**input),
            Param::Context => None,
        })
    }
}

#[derive(Default)]
struct Errors(Option<syn::Error>);

impl Errors {
    fn push(&mut self, error: syn::Error) {
        match &mut self.0 {
            Some(errors) => errors.combine(error),
            None => self.0 = Some(error),
        }
    }

    fn finish<T>(self, value: T) -> syn::Result<T> {
        self.0.map_or(Ok(value), Err)
    }
}

/// Checks `sig` and strips the parameter attributes the macro consumes (`#[tool(context)]`, doc
/// comments, `#[serde]` and `#[schemars]`), which are not valid on function parameters.
pub(crate) fn analyze(sig: &mut Signature, kind: FnKind) -> syn::Result<ToolSignature> {
    let mut errors = Errors::default();
    check_qualifiers(sig, &mut errors);
    let mut params = Vec::new();
    let mut has_receiver = false;
    let mut context_seen = false;
    for arg in &mut sig.inputs {
        match arg {
            FnArg::Receiver(receiver) => {
                has_receiver = true;
                if let Err(error) = check_receiver(receiver, kind) {
                    errors.push(error);
                }
            }
            FnArg::Typed(pat_type) => match analyze_param(pat_type, kind, &mut context_seen) {
                Ok(param) => params.push(param),
                Err(error) => errors.push(error),
            },
        }
    }
    if kind == FnKind::Method && !has_receiver {
        errors.push(syn::Error::new(sig.ident.span(), "`#[tool]` methods must take `&self`"));
    }
    let (result, output_span) = match &sig.output {
        ReturnType::Default => (None, sig.span()),
        ReturnType::Type(_, ty) => (is_result(ty).then(|| ty.span()), ty.span()),
    };
    errors.finish(ToolSignature {
        params,
        result,
        output_span,
    })
}

fn check_qualifiers(sig: &Signature, errors: &mut Errors) {
    if sig.asyncness.is_none() {
        errors.push(syn::Error::new(
            sig.fn_token.span,
            "`#[tool]` functions must be `async`",
        ));
    }
    if let Some(constness) = &sig.constness {
        errors.push(syn::Error::new(constness.span, "`#[tool]` functions cannot be `const`"));
    }
    if let Safety::Unsafe(unsafety) = &sig.safety {
        errors.push(syn::Error::new(unsafety.span, "`#[tool]` functions cannot be `unsafe`"));
    }
    if let Some(abi) = &sig.abi {
        errors.push(syn::Error::new_spanned(
            abi,
            "`#[tool]` functions cannot declare an ABI",
        ));
    }
    if !sig.generics.params.is_empty() || sig.generics.where_clause.is_some() {
        errors.push(syn::Error::new_spanned(
            &sig.generics,
            "`#[tool]` functions cannot be generic; parameter types must be concrete",
        ));
    }
    if let Some(variadic) = &sig.variadic {
        errors.push(syn::Error::new_spanned(
            variadic,
            "`#[tool]` functions cannot be variadic",
        ));
    }
}

fn check_receiver(receiver: &syn::Receiver, kind: FnKind) -> syn::Result<()> {
    if kind == FnKind::Free {
        return Err(syn::Error::new_spanned(
            receiver,
            "`#[tool]` on a method needs `#[tools]` on its `impl` block",
        ));
    }
    let shared_ref = match &receiver.kind {
        ReceiverKind::Reference(_, _, mutability) => mutability.is_none(),
        ReceiverKind::Typed(_, ty) => matches!(
            &**ty,
            Type::Reference(reference) if reference.mutability.is_none() && is_self(&reference.elem)
        ),
        _ => false,
    };
    if !shared_ref {
        return Err(syn::Error::new_spanned(receiver, "`#[tool]` methods must take `&self`"));
    }
    Ok(())
}

fn analyze_param(pat_type: &mut PatType, kind: FnKind, context_seen: &mut bool) -> syn::Result<Param> {
    let mut context_attr = None;
    let mut moved = Vec::new();
    let mut kept = Vec::new();
    for attr in std::mem::take(&mut pat_type.attrs) {
        if is_tool_attr(&attr) {
            check_context_attr(&attr)?;
            context_attr = Some(attr);
        } else if ["doc", "serde", "schemars"]
            .iter()
            .any(|name| attr.path().is_ident(name))
        {
            moved.push(attr);
        } else {
            kept.push(attr);
        }
    }
    pat_type.attrs = kept;
    if let Some(attr) = context_attr {
        return context_param(pat_type, &attr, context_seen);
    }
    let ident = param_ident(&pat_type.pat)?;
    check_input_type(&pat_type.ty, kind)?;
    Ok(Param::Input(Box::new(InputParam {
        ident,
        ty: (*pat_type.ty).clone(),
        attrs: moved,
    })))
}

fn context_param(pat_type: &PatType, attr: &Attribute, context_seen: &mut bool) -> syn::Result<Param> {
    if *context_seen {
        return Err(syn::Error::new_spanned(
            attr,
            "only one parameter can be `#[tool(context)]`",
        ));
    }
    *context_seen = true;
    if !is_context_ref(&pat_type.ty) {
        return Err(syn::Error::new_spanned(
            &pat_type.ty,
            "the `#[tool(context)]` parameter must have type `&ToolContext`",
        ));
    }
    Ok(Param::Context)
}

fn param_ident(pat: &Pat) -> syn::Result<Ident> {
    match pat {
        Pat::Ident(pat_ident) if pat_ident.by_ref.is_none() && pat_ident.subpat.is_none() => {
            Ok(pat_ident.ident.clone())
        }
        _ => Err(syn::Error::new_spanned(
            pat,
            "`#[tool]` parameters must be plain identifiers; they name the input properties",
        )),
    }
}

fn check_input_type(ty: &Type, kind: FnKind) -> syn::Result<()> {
    if is_context_ref(ty) {
        return Err(syn::Error::new_spanned(
            ty,
            "mark the `&ToolContext` parameter with `#[tool(context)]`",
        ));
    }
    let mut check = TypeCheck { kind, error: None };
    check.visit_type(ty);
    check.error.map_or(Ok(()), Err)
}

struct TypeCheck {
    kind: FnKind,
    error: Option<syn::Error>,
}

impl TypeCheck {
    fn fail(&mut self, tokens: impl quote::ToTokens, message: &str) {
        if self.error.is_none() {
            self.error = Some(syn::Error::new_spanned(tokens, message));
        }
    }
}

impl<'ast> Visit<'ast> for TypeCheck {
    fn visit_type_impl_trait(&mut self, node: &'ast syn::TypeImplTrait) {
        self.fail(
            node,
            "`#[tool]` parameters cannot use `impl Trait`; use a concrete type",
        );
    }

    fn visit_type_reference(&mut self, node: &'ast syn::TypeReference) {
        self.fail(
            node,
            "`#[tool]` parameters must be owned types, because they are deserialized from the tool input",
        );
    }

    fn visit_type_path(&mut self, node: &'ast syn::TypePath) {
        if self.kind == FnKind::Method
            && node.qself.is_none()
            && node.path.segments.first().is_some_and(|s| s.ident == "Self")
        {
            self.fail(node, "`#[tool]` parameter types cannot name `Self`; name the type");
        }
        syn::visit::visit_type_path(self, node);
    }
}

fn is_self(ty: &Type) -> bool {
    matches!(ty, Type::Path(path) if path.qself.is_none() && path.path.is_ident("Self"))
}

fn is_context_ref(ty: &Type) -> bool {
    let Type::Reference(reference) = ty else {
        return false;
    };
    reference.mutability.is_none() && last_segment_is(&reference.elem, "ToolContext")
}

fn is_result(ty: &Type) -> bool {
    last_segment_is(ty, "Result")
}

fn last_segment_is(ty: &Type, name: &str) -> bool {
    let Type::Path(path) = ty else {
        return false;
    };
    path.qself.is_none() && path.path.segments.last().is_some_and(|segment| segment.ident == name)
}
