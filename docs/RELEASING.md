# Releasing Agent 86

Releases are built by [`.github/workflows/release.yml`](../.github/workflows/release.yml) when a
tag `vX.Y.Z` is pushed. It builds every installer into a **draft** GitHub Release with the updater
manifest `latest.json`; a maintainer checks the draft and publishes it. Installed apps see an update
only once the release is published (the updater reads `releases/latest/download/latest.json`, and
GitHub's "latest" skips drafts and pre-releases).

## One-time setup

### The updater key (required)

Updates are signed with a minisign key made by `tauri signer generate`. The public half is
`plugins.updater.pubkey` in `src-tauri/tauri.conf.json`; every installed copy trusts only updates
signed with the matching private key. **Keep the private key and its password backed up**: without
them, apps already installed can never update again (a new key needs a new public key in a release
users install by hand).

Set the two repository secrets (Settings, Secrets and variables, Actions), or with the GitHub CLI:

```sh
gh secret set TAURI_SIGNING_PRIVATE_KEY -R Maetek-Technologies/agent86-desktop < updater.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD -R Maetek-Technologies/agent86-desktop < updater.key.password
```

The workflow stops with an error when `TAURI_SIGNING_PRIVATE_KEY` is missing.

### Code signing (optional, recommended)

Without it the installers work, but Windows SmartScreen and macOS Gatekeeper warn on first launch
(the [user guide](USER_GUIDE.md#the-first-time-you-open-it) explains what to do). Each platform is
signed when its secrets are set:

| Platform | Secrets                                                                 |
| -------- | ----------------------------------------------------------------------- |
| Windows  | `WINDOWS_CERTIFICATE` (the code-signing `.pfx`, base64), `WINDOWS_CERTIFICATE_PASSWORD` |
| macOS    | `APPLE_CERTIFICATE` (Developer ID Application `.p12`, base64), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` (e.g. `Developer ID Application: Maetek Technologies (TEAMID)`), and for notarization `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password), `APPLE_TEAM_ID` |

Base64 a file with `base64 -w0 file` (Linux), `base64 -i file` (macOS), or
`[Convert]::ToBase64String([IO.File]::ReadAllBytes("file"))` (PowerShell).

## Each release

1. Make sure `main` is green in CI.
2. Set the version in `package.json` and `src-tauri/Cargo.toml` (the app reads it from
   `package.json`), run `cargo check` in `src-tauri` so `Cargo.lock` follows, and commit.
3. Tag and push: `git tag v1.2.3 && git push origin v1.2.3`. The workflow refuses a tag that does
   not match `package.json`.
4. Wait for the four builds (Windows, macOS arm64 and x64, Linux). Open the draft release and check
   it has, for this version: `*_x64-setup.exe` and `*_x64_en-US.msi` (each with a `.sig`), both
   `.dmg` files and `*.app.tar.gz` (with `.sig`) for `aarch64` and `x64`, the `.AppImage` (with
   `.sig`), `.deb`, `.rpm`, and `latest.json` listing `windows-x86_64`, `darwin-aarch64`,
   `darwin-x86_64`, and `linux-x86_64`.
5. Edit the release notes, then **Publish release**. Apps that check for updates find it from then
   on.

A broken draft can be deleted with its tag (`git push --delete origin v1.2.3`) and tagged again.

## Building installers locally

`pnpm app:build` builds this platform's installers into `src-tauri/target/release/bundle/`.
Because the app makes updater artifacts, the build needs the key in the environment:

```sh
export TAURI_SIGNING_PRIVATE_KEY="$(cat path/to/updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat path/to/updater.key.password)"
pnpm app:build
```

Without the key, build with `pnpm tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}'`.
