//! Data types for sandbox operations: execution results, file metadata and streaming chunks.

/// Which output stream a [`StreamChunk`] came from (`StreamType`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum StreamType {
    /// Standard output (`'stdout'`).
    Stdout,
    /// Standard error (`'stderr'`).
    Stderr,
}

impl StreamType {
    /// The stream's name: `"stdout"` or `"stderr"`.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stdout => "stdout",
            Self::Stderr => "stderr",
        }
    }
}

/// A chunk of output from a running command or code execution (`StreamChunk`).
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct StreamChunk {
    /// The decoded text.
    pub data: String,
    /// The stream the text was written to.
    pub stream_type: StreamType,
}

impl StreamChunk {
    /// Creates a chunk of `data` written to `stream_type`.
    pub fn new(data: impl Into<String>, stream_type: StreamType) -> Self {
        Self {
            data: data.into(),
            stream_type,
        }
    }
}

/// Metadata about a file or directory in a sandbox (`FileInfo`).
///
/// `is_dir` and `size` are `None` when the backend cannot determine them.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct FileInfo {
    /// The entry name, without its directory.
    pub name: String,
    /// Whether the entry is a directory.
    pub is_dir: Option<bool>,
    /// The size in bytes.
    pub size: Option<u64>,
}

impl FileInfo {
    /// Creates an entry with unknown type and size.
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            is_dir: None,
            size: None,
        }
    }

    /// Sets whether the entry is a directory.
    #[must_use]
    pub fn with_is_dir(mut self, is_dir: bool) -> Self {
        self.is_dir = Some(is_dir);
        self
    }

    /// Sets the size in bytes.
    #[must_use]
    pub fn with_size(mut self, size: u64) -> Self {
        self.size = Some(size);
        self
    }
}

/// A file produced by code execution, such as a chart or a PDF (`OutputFile`).
///
/// Shell-based sandboxes return none; Jupyter- or API-backed sandboxes can.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct OutputFile {
    /// The file name.
    pub name: String,
    /// The raw content.
    pub content: Vec<u8>,
    /// The MIME type, for example `image/png`.
    pub mime_type: String,
}

impl OutputFile {
    /// Creates an output file.
    pub fn new(name: impl Into<String>, content: impl Into<Vec<u8>>, mime_type: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            content: content.into(),
            mime_type: mime_type.into(),
        }
    }
}

/// The result of a command or code execution (`ExecutionResult`).
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct ExecutionResult {
    /// The exit code; `0` is success. A missing command or interpreter is `127`, and a process
    /// killed by a signal is `128` plus the signal number.
    pub exit_code: i32,
    /// Everything written to standard output.
    pub stdout: String,
    /// Everything written to standard error.
    pub stderr: String,
    /// Files the execution produced.
    pub output_files: Vec<OutputFile>,
}

impl ExecutionResult {
    /// Creates a result with no output files.
    pub fn new(exit_code: i32, stdout: impl Into<String>, stderr: impl Into<String>) -> Self {
        Self {
            exit_code,
            stdout: stdout.into(),
            stderr: stderr.into(),
            output_files: Vec::new(),
        }
    }

    /// Sets the files the execution produced.
    #[must_use]
    pub fn with_output_files(mut self, output_files: Vec<OutputFile>) -> Self {
        self.output_files = output_files;
        self
    }
}

/// An item of an execution stream: a [`StreamChunk`] or the final [`ExecutionResult`].
///
/// A stream yields chunks as output arrives and ends with exactly one
/// [`ExecutionResult`](ExecutionStreamItem::ExecutionResult), or with an error.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ExecutionStreamItem {
    /// Output written while the command runs (`type: 'streamChunk'`).
    StreamChunk(StreamChunk),
    /// The final result (`type: 'executionResult'`).
    ExecutionResult(ExecutionResult),
}

impl From<StreamChunk> for ExecutionStreamItem {
    fn from(chunk: StreamChunk) -> Self {
        Self::StreamChunk(chunk)
    }
}

impl From<ExecutionResult> for ExecutionStreamItem {
    fn from(result: ExecutionResult) -> Self {
        Self::ExecutionResult(result)
    }
}
