//! Embed Cargo's complete compilation target for fail-closed native ABI selection.

/// Emit trusted build metadata only; missing or multiline target identifiers fail the build.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let target = std::env::var("TARGET")?;
    if target.contains(['\r', '\n']) {
        return Err("Cargo target must be a single identifier".into());
    }
    println!("cargo:rustc-env=AGENT_INSIGHTS_NATIVE_TARGET={target}");
    println!("cargo:rerun-if-env-changed=TARGET");
    Ok(())
}
