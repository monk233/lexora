#!/usr/bin/env bash
# Compile the production lookup module in isolation from the Windows shell.
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
check_dir="$(mktemp -d "${TMPDIR:-/tmp}/lexora-pronunciation.XXXXXXXX")"
trap 'rm -rf -- "$check_dir"' EXIT
mkdir -p "$check_dir/src" "$check_dir/src-tauri/src/engine"
# Preserve the production module's relative data and project-license paths.
cp "$repo_root/src-tauri/src/engine/pronunciation.rs" "$check_dir/src-tauri/src/engine/"
cp -R "$repo_root/src-tauri/src/engine/pronunciation-data" "$check_dir/src-tauri/src/engine/"
cp "$repo_root/LICENSE" "$check_dir/LICENSE"
printf '%s\n' '#[path = "../src-tauri/src/engine/pronunciation.rs"]' 'pub mod pronunciation;' > "$check_dir/src/lib.rs"
cat > "$check_dir/Cargo.toml" <<'TOML'
[package]
name = "lexora-pronunciation-portable-check"
version = "0.1.0"
edition = "2021"

[dependencies]
serde = { version = "1", features = ["derive"] }
zip = { version = "2", default-features = false, features = ["deflate"] }

[dev-dependencies]
serde_json = "1"
TOML
cargo generate-lockfile --manifest-path "$check_dir/Cargo.toml"
cargo check --all-targets --locked --manifest-path "$check_dir/Cargo.toml"
cargo test --locked --manifest-path "$check_dir/Cargo.toml"
