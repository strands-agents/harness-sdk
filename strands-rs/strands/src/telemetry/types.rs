//! Telemetry value types.

#[cfg(feature = "otel")]
use opentelemetry::{Array, StringValue};

/// The value of a span attribute (OpenTelemetry `AttributeValue`): a string, number or boolean,
/// or a homogeneous array of them.
///
/// ```
/// use strands::telemetry::AttributeValue;
///
/// assert_eq!(AttributeValue::from("sess-1"), AttributeValue::String("sess-1".into()));
/// assert_eq!(AttributeValue::from(3), AttributeValue::I64(3));
/// ```
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum AttributeValue {
    /// A string.
    String(String),
    /// A boolean.
    Bool(bool),
    /// An integer.
    I64(i64),
    /// A floating point number.
    F64(f64),
    /// An array of strings.
    StringArray(Vec<String>),
    /// An array of booleans.
    BoolArray(Vec<bool>),
    /// An array of integers.
    I64Array(Vec<i64>),
    /// An array of floating point numbers.
    F64Array(Vec<f64>),
}

impl From<&str> for AttributeValue {
    fn from(value: &str) -> Self {
        Self::String(value.to_owned())
    }
}

impl From<String> for AttributeValue {
    fn from(value: String) -> Self {
        Self::String(value)
    }
}

impl From<&String> for AttributeValue {
    fn from(value: &String) -> Self {
        Self::String(value.clone())
    }
}

impl From<bool> for AttributeValue {
    fn from(value: bool) -> Self {
        Self::Bool(value)
    }
}

impl From<i64> for AttributeValue {
    fn from(value: i64) -> Self {
        Self::I64(value)
    }
}

impl From<i32> for AttributeValue {
    fn from(value: i32) -> Self {
        Self::I64(i64::from(value))
    }
}

impl From<u32> for AttributeValue {
    fn from(value: u32) -> Self {
        Self::I64(i64::from(value))
    }
}

impl From<u64> for AttributeValue {
    /// Values above `i64::MAX` saturate.
    fn from(value: u64) -> Self {
        Self::I64(i64::try_from(value).unwrap_or(i64::MAX))
    }
}

impl From<f64> for AttributeValue {
    fn from(value: f64) -> Self {
        Self::F64(value)
    }
}

impl From<Vec<String>> for AttributeValue {
    fn from(value: Vec<String>) -> Self {
        Self::StringArray(value)
    }
}

impl From<Vec<&str>> for AttributeValue {
    fn from(value: Vec<&str>) -> Self {
        Self::StringArray(value.into_iter().map(str::to_owned).collect())
    }
}

impl From<Vec<bool>> for AttributeValue {
    fn from(value: Vec<bool>) -> Self {
        Self::BoolArray(value)
    }
}

impl From<Vec<i64>> for AttributeValue {
    fn from(value: Vec<i64>) -> Self {
        Self::I64Array(value)
    }
}

impl From<Vec<f64>> for AttributeValue {
    fn from(value: Vec<f64>) -> Self {
        Self::F64Array(value)
    }
}

#[cfg(feature = "otel")]
impl From<AttributeValue> for opentelemetry::Value {
    fn from(value: AttributeValue) -> Self {
        match value {
            AttributeValue::String(value) => Self::String(value.into()),
            AttributeValue::Bool(value) => Self::Bool(value),
            AttributeValue::I64(value) => Self::I64(value),
            AttributeValue::F64(value) => Self::F64(value),
            AttributeValue::StringArray(values) => {
                Self::Array(Array::String(values.into_iter().map(StringValue::from).collect()))
            }
            AttributeValue::BoolArray(values) => Self::Array(Array::Bool(values)),
            AttributeValue::I64Array(values) => Self::Array(Array::I64(values)),
            AttributeValue::F64Array(values) => Self::Array(Array::F64(values)),
        }
    }
}
