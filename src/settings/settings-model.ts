// Pure helpers for the settings screens: no IPC, no React. Rust checks settings again when they
// are saved (src-tauri/src/settings.rs `problems`), so these only shape what the forms edit.
import type {
  KeyUse,
  ProviderKind,
  ProviderPreset,
  ProviderSettings,
  Settings,
} from "../desktop-client/events.ts";

export const KIND_LABELS: Record<ProviderKind, string> = {
  openai: "OpenAI-compatible",
  anthropic: "Anthropic",
  google: "Google Gemini",
  ollama: "Ollama",
  vllm: "vLLM",
  lmstudio: "LM Studio",
  llamacpp: "llama.cpp",
};

/** The key use a kind fixes, as `ProviderKind::fixed_key_use` in Rust; `null` for OpenAI-compatible. */
export function fixedKeyUse(kind: ProviderKind): KeyUse | null {
  switch (kind) {
    case "anthropic":
    case "google":
      return "required";
    case "ollama":
      return "none";
    case "vllm":
    case "lmstudio":
    case "llamacpp":
      return "optional";
    case "openai":
      return null;
  }
}

/** Whether `provider` needs a key, may use one, or never does. */
export function keyUse(provider: ProviderSettings): KeyUse {
  return fixedKeyUse(provider.kind) ?? provider.key;
}

/** `provider:model` split at the first colon; `null` unless both parts are there. */
export function splitRef(reference: string): { provider: string; model: string } | null {
  const at = reference.indexOf(":");
  if (at <= 0 || at === reference.length - 1) return null;
  return { provider: reference.slice(0, at).trim(), model: reference.slice(at + 1).trim() };
}

/** The model references the settings use: the default and the triage pair. */
export function modelRefs(settings: Settings): string[] {
  const refs = [settings.model.default];
  if (settings.model.triage) refs.push(settings.model.triage.cheap, settings.model.triage.frontier);
  return refs.filter((r) => r.trim() !== "");
}

/** The model references that use provider `name`. */
export function usersOf(settings: Settings, name: string): string[] {
  return modelRefs(settings).filter((r) => splitRef(r)?.provider === name);
}

/** `base`, or `base-2`, `base-3`, ... whichever is not taken. */
export function uniqueName(taken: Iterable<string>, base: string): string {
  const names = new Set(taken);
  if (!names.has(base)) return base;
  for (let n = 2; ; n++) if (!names.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** A name agent86 accepts for a provider (and a keyring account): letters, digits, `-_.`. */
export function validProviderName(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(name);
}

/** A name for an MCP server: letters, digits, `-_`. */
export function validServerName(name: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(name);
}

export function withProvider(
  settings: Settings,
  name: string,
  provider: ProviderSettings,
): Settings {
  return { ...settings, providers: { ...settings.providers, [name]: provider } };
}

export function withoutProvider(settings: Settings, name: string): Settings {
  const providers = { ...settings.providers };
  delete providers[name];
  return { ...settings, providers };
}

/**
 * First-run settings: the defaults with one provider (from `preset`, under `name`, at `baseUrl`
 * when given) and `model` on it as the default model.
 */
export function setupSettings(
  defaults: Settings,
  preset: ProviderPreset,
  name: string,
  model: string,
  baseUrl: string,
): Settings {
  const url = baseUrl.trim();
  const provider: ProviderSettings = {
    ...preset.provider,
    baseUrl: url === "" ? preset.provider.baseUrl : url,
  };
  return {
    ...defaults,
    providers: { [name]: provider },
    model: { ...defaults.model, default: `${name}:${model.trim()}` },
  };
}

/** `NAME=value` lines (or `Name: value` with `separator` ":") as a record; blank lines skipped. */
export function parsePairs(
  text: string,
  separator: "=" | ":" = "=",
): { pairs: Record<string, string> } | { error: string } {
  const pairs: Record<string, string> = {};
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === "") continue;
    const at = line.indexOf(separator);
    if (at <= 0) return { error: `Line ${i + 1} should be written name${separator}value.` };
    pairs[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { pairs };
}

export function formatPairs(pairs: Record<string, string>, separator: "=" | ":" = "="): string {
  const gap = separator === ":" ? ": " : "=";
  return Object.entries(pairs)
    .map(([k, v]) => `${k}${gap}${v}`)
    .join("\n");
}

/** Non-empty trimmed lines. */
export function parseLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/** `text` as a whole number of at least `min`, else `null`. */
export function parseCount(text: string, min = 0): number | null {
  if (!/^\s*\d+\s*$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) && n >= min ? n : null;
}

/** `text` as a non-negative number, else `null`. */
export function parseAmount(text: string): number | null {
  if (!/^\s*\d+(\.\d+)?\s*$/.test(text)) return null;
  return Number(text);
}

/** Settings compared by value, to tell whether a draft has changed. */
export function sameSettings(a: Settings, b: Settings): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
