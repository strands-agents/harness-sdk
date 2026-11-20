//! On/off options that take a configuration when on.

/// Turns a `boolean | config` option on or off: `true.into()`, `false.into()` or a config
/// `.into()`.
///
/// ```
/// use strands::Toggle;
/// use strands::memory::MemoryToolConfig;
///
/// let on: Toggle<MemoryToolConfig> = true.into();
/// assert_eq!(on, Toggle::On(MemoryToolConfig::default()));
/// let off: Toggle<MemoryToolConfig> = false.into();
/// assert_eq!(off, Toggle::Off);
/// ```
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum Toggle<T> {
    /// Off (`false`).
    Off,
    /// On with a configuration; `true` is `On(T::default())`.
    On(T),
}

impl<T: Default> From<bool> for Toggle<T> {
    fn from(enabled: bool) -> Self {
        if enabled { Self::On(T::default()) } else { Self::Off }
    }
}

impl<T> Toggle<T> {
    pub(crate) fn into_option(self) -> Option<T> {
        match self {
            Self::Off => None,
            Self::On(config) => Some(config),
        }
    }
}

/// `From<Config> for Toggle<Config>` for each config type (a blanket impl would overlap
/// `From<bool>`).
macro_rules! toggle_from_config {
    ($($config:ty),*) => {
        $(impl From<$config> for $crate::types::Toggle<$config> {
            fn from(config: $config) -> Self {
                Self::On(config)
            }
        })*
    };
}
pub(crate) use toggle_from_config;
