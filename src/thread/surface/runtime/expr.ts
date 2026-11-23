// `formatString`'s template language: literal text with `${...}` interpolations, each a literal, a
// data binding, or a function call.
//
// The grammar is the one every A2UI SDK parses (the specification's "The `formatString` function"
// and the shared suite `core/expressions.yaml`):
//
// - `\${` is a literal `${`; an unclosed `${` is an error.
// - Inside `${...}`: a nested `${...}`, a quoted string (`'...'` or `"..."`, with `\n`, `\t`, `\r`,
//   and `\x` for any other `x`), a number (`[+-]?(digits[.digits]|.digits)([eE][+-]?digits)?`,
//   finite), `true`, `false`, `null` (which reads as `""`), a path (characters that are
//   `XID_Continue`, `/`, `.`, or `-`; relative unless it starts with `/`), or a call: a name then
//   `(name: value, ...)`, the arguments themselves expressions. `@`-names (`@index`) must be calls.
// - At most MAX_DEPTH levels of nesting, MAX_TEMPLATE_LENGTH UTF-16 units, and MAX_PARTS parts, so
//   every SDK accepts and refuses the same templates.

import { put } from "./json.ts";
import type { Json, JsonObject } from "./types.ts";

/** The deepest nesting of interpolations and call arguments. */
export const MAX_DEPTH = 100;
/** The longest template, in UTF-16 code units. */
export const MAX_TEMPLATE_LENGTH = 10_000;
/** The most parts one template may produce. */
export const MAX_PARTS = 1_000;

/** A template that does not parse. */
export class ExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpressionError";
  }
}

/** One piece of a parsed template. */
export type Part =
  /** A literal: text, a number, or a boolean (`null` is parsed as `""`). */
  | { kind: "literal"; value: Json }
  /** A data binding, absolute or relative. */
  | { kind: "path"; path: string }
  /** A function call with named arguments, in the order written. */
  | { kind: "call"; name: string; args: [string, Part][] };

const literal = (value: Json): Part => ({ kind: "literal", value });

/** The part in the shared suite's JSON form: a literal as itself, a binding as `{"path": ...}`, a
 * call as `{"call", "args", "returnType"}`. */
export function partToJson(part: Part): Json {
  switch (part.kind) {
    case "literal":
      return part.value;
    case "path":
      return { path: part.path };
    case "call": {
      const args: JsonObject = {};
      for (const [key, value] of part.args) put(args, key, partToJson(value));
      return { call: part.name, args, returnType: "any" };
    }
  }
}

/** JavaScript's `\s`: ECMAScript WhiteSpace and LineTerminator. */
function isSpace(c: string | undefined): boolean {
  return c !== undefined && /^\s$/u.test(c);
}

const XID_CONTINUE = /^\p{XID_Continue}$/u;

function isIdContinue(c: string | undefined): boolean {
  return c !== undefined && XID_CONTINUE.test(c);
}

const isAsciiDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";

/** Walks a string by code point, as the Rust scanner walks `char`s. */
class Scanner {
  readonly chars: string[];
  pos = 0;

  constructor(text: string) {
    this.chars = Array.from(text);
  }

  atEnd(): boolean {
    return this.pos >= this.chars.length;
  }

  peek(offset = 0): string | undefined {
    return this.chars[this.pos + offset];
  }

  advance(): string | undefined {
    const c = this.peek();
    this.pos += 1;
    return c;
  }

  matches(expected: string): boolean {
    return Array.from(expected).every((c, i) => this.peek(i) === c);
  }

  eat(expected: string): boolean {
    if (this.peek() === expected) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  skipSpace(): void {
    while (isSpace(this.peek())) this.pos += 1;
  }

  keyword(word: string): boolean {
    const n = Array.from(word).length;
    if (this.matches(word) && !isIdContinue(this.peek(n))) {
      this.pos += n;
      return true;
    }
    return false;
  }

  slice(start: number, end: number): string {
    return this.chars.slice(start, end).join("");
  }

  rest(): string {
    return this.slice(Math.min(this.pos, this.chars.length), this.chars.length);
  }
}

/** Parse a template into its parts. Adjacent text stays one literal; empty literals are dropped.
 * Throws ExpressionError. */
export function parse(template: string): Part[] {
  return parseAt(template, 0);
}

function parseAt(template: string, depth: number): Part[] {
  if (depth > MAX_DEPTH) throw new ExpressionError("Max recursion depth reached in parse");
  const length = template.length;
  if (length > MAX_TEMPLATE_LENGTH) {
    throw new ExpressionError(
      `Expression template length (${length}) exceeds maximum limit (${MAX_TEMPLATE_LENGTH})`,
    );
  }
  if (template === "") return [];
  if (!template.includes("${")) return [literal(template)];
  const parts: Part[] = [];
  const scanner = new Scanner(template);
  while (!scanner.atEnd()) {
    if (parts.length >= MAX_PARTS) {
      throw new ExpressionError(`Expression parts count exceeds maximum limit (${MAX_PARTS})`);
    }
    if (scanner.matches("${")) {
      scanner.pos += 2;
      const content = interpolation(scanner);
      parts.push(expression(content, depth + 1));
    } else if (scanner.matches("\\${")) {
      scanner.pos += 3;
      parts.push(literal("${"));
    } else {
      const start = scanner.pos;
      while (!scanner.atEnd() && !scanner.matches("${") && !scanner.matches("\\${")) {
        scanner.pos += 1;
      }
      parts.push(literal(scanner.slice(start, scanner.pos)));
    }
  }
  return join(parts);
}

/** Join adjacent text literals and drop empty ones. */
function join(parts: Part[]): Part[] {
  const out: Part[] = [];
  for (const part of parts) {
    if (part.kind === "literal" && typeof part.value === "string") {
      if (part.value === "") continue;
      const previous = out.at(-1);
      if (previous?.kind === "literal" && typeof previous.value === "string") {
        out[out.length - 1] = literal(previous.value + part.value);
        continue;
      }
    }
    out.push(part);
  }
  return out;
}

/** The text of an interpolation, after its `${`, up to its matching `}` (braces inside quoted
 * strings do not count). */
function interpolation(scanner: Scanner): string {
  const start = scanner.pos;
  let balance = 1;
  for (let c = scanner.advance(); c !== undefined; c = scanner.advance()) {
    if (c === "{") {
      balance += 1;
    } else if (c === "}") {
      balance -= 1;
      if (balance === 0) return scanner.slice(start, scanner.pos - 1);
    } else if (c === "'" || c === '"') {
      for (let inner = scanner.advance(); inner !== undefined; inner = scanner.advance()) {
        if (inner === "\\") scanner.advance();
        else if (inner === c) break;
      }
    }
  }
  throw new ExpressionError("Unclosed interpolation: missing '}'");
}

function trim(text: string): string {
  const chars = Array.from(text);
  let start = 0;
  let end = chars.length;
  while (start < end && isSpace(chars[start])) start++;
  while (end > start && isSpace(chars[end - 1])) end--;
  return chars.slice(start, end).join("");
}

function expression(raw: string, depth: number): Part {
  const text = trim(raw);
  if (text === "") return literal("");
  const scanner = new Scanner(text);
  const part = value(scanner, depth);
  if (!scanner.atEnd()) {
    throw new ExpressionError(`Unexpected characters at end of expression: '${scanner.rest()}'`);
  }
  return part;
}

function value(scanner: Scanner, depth: number): Part {
  if (depth > MAX_DEPTH) throw new ExpressionError("Max recursion depth reached in parse");
  scanner.skipSpace();
  if (scanner.atEnd()) return literal("");
  if (scanner.matches("${")) {
    scanner.pos += 2;
    const content = interpolation(scanner);
    return expression(content, depth + 1);
  }
  const first = scanner.peek();
  if (first === "'" || first === '"') return literal(string(scanner));
  if (numberStart(scanner)) return literal(number(scanner));
  if (scanner.keyword("true")) return literal(true);
  if (scanner.keyword("false")) return literal(false);
  if (scanner.keyword("null")) return literal("");
  const token = pathOrName(scanner);
  scanner.skipSpace();
  if (scanner.peek() === "(") return call(token, scanner, depth);
  if (token.startsWith("@")) {
    throw new ExpressionError(`Expected '(' after function name '${token}'`);
  }
  if (token === "") return literal("");
  return { kind: "path", path: token };
}

const isAsciiAlpha = (c: string | undefined) => c !== undefined && /^[A-Za-z]$/.test(c);
const isAsciiWord = (c: string | undefined) => c !== undefined && /^[A-Za-z0-9_]$/.test(c);

function pathOrName(scanner: Scanner): string {
  const start = scanner.pos;
  if (scanner.peek() === "@") {
    const next = scanner.peek(1);
    if (!(isAsciiAlpha(next) || next === "_")) {
      throw new ExpressionError("Invalid identifier starting with '@' in expression");
    }
    scanner.pos += 1;
    while (isAsciiWord(scanner.peek())) scanner.pos += 1;
    return scanner.slice(start, scanner.pos);
  }
  for (;;) {
    const c = scanner.peek();
    if (!(isIdContinue(c) || c === "/" || c === "." || c === "-")) break;
    scanner.pos += 1;
  }
  return scanner.slice(start, scanner.pos);
}

function call(name: string, scanner: Scanner, depth: number): Part {
  scanner.eat("(");
  scanner.skipSpace();
  const args: [string, Part][] = [];
  while (!scanner.atEnd() && scanner.peek() !== ")") {
    const start = scanner.pos;
    while (isIdContinue(scanner.peek())) scanner.pos += 1;
    const arg = scanner.slice(start, scanner.pos);
    scanner.skipSpace();
    if (!scanner.eat(":")) {
      throw new ExpressionError(`Expected ':' after argument name '${arg}' in function '${name}'`);
    }
    scanner.skipSpace();
    const parsed = value(scanner, depth + 1);
    const slot = args.find(([existing]) => existing === arg);
    if (slot) slot[1] = parsed;
    else args.push([arg, parsed]);
    scanner.skipSpace();
    if (scanner.eat(",")) scanner.skipSpace();
  }
  if (!scanner.eat(")")) {
    throw new ExpressionError(`Expected ')' after function arguments for '${name}'`);
  }
  return { kind: "call", name, args };
}

function string(scanner: Scanner): string {
  const quote = scanner.advance() ?? "'";
  let out = "";
  for (let c = scanner.advance(); c !== undefined; c = scanner.advance()) {
    if (c === "\\") {
      const escaped = scanner.advance();
      if (escaped === undefined) break;
      out += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped === "r" ? "\r" : escaped;
    } else if (c === quote) {
      return out;
    } else {
      out += c;
    }
  }
  throw new ExpressionError(`Unclosed string literal: missing closing ${quote}`);
}

function numberStart(scanner: Scanner): boolean {
  const first = scanner.peek();
  const offset = first === "+" || first === "-" ? 1 : 0;
  const c = scanner.peek(offset);
  if (isAsciiDigit(c)) return true;
  return c === "." && isAsciiDigit(scanner.peek(offset + 1));
}

const NUMBER = /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

function number(scanner: Scanner): Json {
  const start = scanner.pos;
  const sign = scanner.peek();
  if (sign === "+" || sign === "-") scanner.pos += 1;
  while (isAsciiDigit(scanner.peek()) || scanner.peek() === ".") scanner.pos += 1;
  const e = scanner.peek();
  if (e === "e" || e === "E") {
    scanner.pos += 1;
    const expSign = scanner.peek();
    if (expSign === "+" || expSign === "-") scanner.pos += 1;
    while (isAsciiDigit(scanner.peek())) scanner.pos += 1;
  }
  const text = scanner.slice(start, scanner.pos);
  if (!NUMBER.test(text)) throw new ExpressionError(`Invalid number literal: '${text}'`);
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) {
    throw new ExpressionError(`Number literal is out of range: '${text}'`);
  }
  return numberValue(parsed);
}

/** A number as JSON: `-0` is `0`, and a non-finite number (which JSON cannot hold) is `null`. */
export function numberValue(value: number): Json {
  if (!Number.isFinite(value)) return null;
  return value === 0 ? 0 : value;
}
