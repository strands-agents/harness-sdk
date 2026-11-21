//! Embeds the shared model info. In the repository it is read from `shared/model-info.json`,
//! the one source of truth for every Strands SDK; a packaged crate ships a copy next to this
//! file instead, which `cargo package` takes from the repository.

use std::env;
use std::error::Error;
use std::fs;
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn Error>> {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR")?);
    let shared = manifest_dir.join("../../shared/model-info.json");
    let packaged = manifest_dir.join("model-info.json");
    println!("cargo::rerun-if-changed={}", shared.display());
    println!("cargo::rerun-if-changed={}", packaged.display());
    let source = if shared.is_file() { shared } else { packaged };
    let data = fs::read_to_string(&source)
        .map_err(|error| format!("cannot read the model info at {}: {error}", source.display()))?;
    fs::write(PathBuf::from(env::var("OUT_DIR")?).join("model-info.json"), data)?;
    Ok(())
}
