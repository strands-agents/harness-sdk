//! The shape every public callback type shares: a cheap-clone newtype over an `Arc`'d closure,
//! built with `new` or from a closure through `From`, callable like the closure through `Deref`.

/// Declares a public callback newtype over `Arc<dyn Fn(..) + Send + Sync>`.
///
/// `new` takes the closure with its signature known, so closures over references need no
/// annotations there; `.into()` works for closures whose argument types are annotated and for
/// functions.
macro_rules! callback {
    ($(#[$meta:meta])* $vis:vis struct $name:ident($($signature:tt)+);) => {
        $(#[$meta])*
        #[derive(Clone)]
        $vis struct $name(::std::sync::Arc<dyn $($signature)+ + Send + Sync>);

        impl $name {
            /// Wraps a closure.
            pub fn new(callback: impl $($signature)+ + Send + Sync + 'static) -> Self {
                Self(::std::sync::Arc::new(callback))
            }
        }

        impl<F: $($signature)+ + Send + Sync + 'static> From<F> for $name {
            fn from(callback: F) -> Self {
                Self(::std::sync::Arc::new(callback))
            }
        }

        impl ::std::ops::Deref for $name {
            type Target = dyn $($signature)+ + Send + Sync;

            fn deref(&self) -> &Self::Target {
                &*self.0
            }
        }

        impl ::std::fmt::Debug for $name {
            fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
                f.write_str(concat!(stringify!($name), "(..)"))
            }
        }
    };
}
pub(crate) use callback;
