// Regenerates the README's badges into docs/images/badges/ from the versions in package.json and
// src-tauri/Cargo.toml. The README links to these files rather than to shields.io, because GitHub's
// image proxy fails to load some shields.io badges. Run `pnpm badges` after a version changes.
import { readFile, writeFile, mkdir } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const out = new URL("docs/images/badges/", root);

const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const cargo = await readFile(new URL("src-tauri/Cargo.toml", root), "utf8");
const toml = (pattern, name) => {
  const match = cargo.match(pattern);
  if (!match) throw new Error(`src-tauri/Cargo.toml: no ${name}`);
  return match[1];
};
const deps = { ...pkg.dependencies, ...pkg.devDependencies };

const badges = {
  release: ["release", `v${pkg.version}`, "blue"],
  license: ["license", pkg.license, "green"],
  "agent86-core": [
    "agent86-core",
    toml(/^agent86-core\s*=\s*"=?([^"]+)"/m, "agent86-core"),
    "dea584",
    "rust",
  ],
  rust: ["rust", `${toml(/^rust-version\s*=\s*"([^"]+)"/m, "rust-version")}+`, "dea584", "rust"],
  tauri: ["tauri", toml(/^tauri\s*=\s*\{\s*version\s*=\s*"([^"]+)"/m, "tauri"), "24c8db", "tauri"],
  react: ["react", deps.react, "61dafb", "react"],
  typescript: ["typescript", deps.typescript, "3178c6", "typescript"],
  platforms: ["platforms", "Linux | macOS | Windows", "lightgrey"],
};

// shields.io's static badge path: dashes and underscores in a field are doubled.
const field = (text) => encodeURIComponent(text.replace(/-/g, "--").replace(/_/g, "__"));

await mkdir(out, { recursive: true });
for (const [file, [label, message, color, logo]] of Object.entries(badges)) {
  const url =
    `https://img.shields.io/badge/${field(label)}-${field(message)}-${color}` +
    (logo ? `?logo=${logo}` : "");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  await writeFile(new URL(`${file}.svg`, out), await response.text());
  console.log(`${file}.svg: ${label} ${message}`);
}
