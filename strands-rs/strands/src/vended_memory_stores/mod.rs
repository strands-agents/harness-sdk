//! Ready-made memory stores: [`file_memory_store`] keeps markdown entries in a
//! [`Storage`](crate::storage::Storage), and [`test_memory_store`] is a zero-infrastructure
//! JSON-file store for prototyping and tests.

pub mod file_memory_store;
pub mod test_memory_store;
