// The A2UI regex dialect (the specification's "The `regex` function"): a portable subset of
// ECMAScript patterns in Unicode mode, a static safety check before anything runs, and search
// semantics.
//
// Patterns come from the agent's model, so they are untrusted. A pattern is parsed here, in full;
// refused if it uses a construct outside the dialect (backreferences, lookbehind, named groups,
// `\p{...}`, `\cX`, legacy octal, inline flags) or could backtrack badly (the four safety rules);
// and only then rebuilt as a JavaScript `RegExp` (`u` flag) with the dialect's meanings spelled
// out (`.`, `\d`, `\w`, `\s` as explicit sets; `^` and `$` at the input's ends). JavaScript has no
// backtracking limit, so the safety rules are the whole defense: nothing reaches `RegExp` unparsed.

/** The longest pattern, in code points. */
export const MAX_PATTERN_CODE_POINTS = 256;
/** The longest value matched, in code points; a longer one does not match. */
export const MAX_VALUE_CODE_POINTS = 4_096;

/** Why a pattern was refused, with the specification's reason names. */
export type Refusal =
  | "UNSUPPORTED_SYNTAX"
  | "PATTERN_TOO_LONG"
  | "NESTED_QUANTIFIER"
  | "OVERLAPPING_ALTERNATION"
  | "ADJACENT_OVERLAP";

class Refused extends Error {
  readonly refusal: Refusal;
  constructor(refusal: Refusal) {
    super(refusal);
    this.refusal = refusal;
  }
}

const unsupported = () => new Refused("UNSUPPORTED_SYNTAX");

/** A set of code points as sorted, disjoint, inclusive ranges. */
type CharSet = [number, number][];

const MAX_CODE_POINT = 0x10ffff;

function normalizeSet(ranges: CharSet): CharSet {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: CharSet = [];
  for (const [lo, hi] of sorted) {
    const last = merged.at(-1);
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else merged.push([lo, hi]);
  }
  return merged;
}

const single = (c: number): CharSet => [[c, c]];

function union(a: CharSet, b: CharSet): CharSet {
  return normalizeSet([...a, ...b]);
}

function negate(set: CharSet): CharSet {
  const out: CharSet = [];
  let next = 0;
  for (const [lo, hi] of set) {
    if (lo > next) out.push([next, lo - 1]);
    next = hi + 1;
  }
  if (next <= MAX_CODE_POINT) out.push([next, MAX_CODE_POINT]);
  return out;
}

function overlaps(a: CharSet, b: CharSet): boolean {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a[i];
    const y = b[j];
    if (!x || !y) break;
    if (x[1] < y[0]) i++;
    else if (y[1] < x[0]) j++;
    else return true;
  }
  return false;
}

const DIGIT: CharSet = [[0x30, 0x39]];
const WORD: CharSet = normalizeSet([
  [0x30, 0x39],
  [0x41, 0x5a],
  [0x5f, 0x5f],
  [0x61, 0x7a],
]);
/** ECMAScript WhiteSpace and LineTerminator. */
const SPACE: CharSet = normalizeSet([
  [0x09, 0x0d],
  [0x20, 0x20],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
]);
/** `.`: anything but the line terminators. */
const DOT: CharSet = negate(
  normalizeSet([
    [0x0a, 0x0a],
    [0x0d, 0x0d],
    [0x2028, 0x2029],
  ]),
);

type Node =
  | { kind: "empty" }
  | { kind: "set"; set: CharSet }
  | { kind: "start" }
  | { kind: "end" }
  | { kind: "boundary"; negated: boolean }
  | { kind: "look"; negated: boolean; body: Node }
  | { kind: "group"; capturing: boolean; body: Node }
  | { kind: "concat"; items: Node[] }
  | { kind: "alt"; items: Node[] }
  | { kind: "repeat"; body: Node; min: number; max: number | null; lazy: boolean };

const EMPTY: Node = { kind: "empty" };
const setNode = (set: CharSet): Node => ({ kind: "set", set });

const SYNTAX = "^$\\.*+?()[]{}|/";
const U32_MAX = 0xffffffff;

const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const isHex = (c: string | undefined) => c !== undefined && /^[0-9a-fA-F]$/.test(c);

class Parser {
  readonly chars: string[];
  pos = 0;

  constructor(pattern: string) {
    this.chars = Array.from(pattern);
  }

  peek(offset = 0): string | undefined {
    return this.chars[this.pos + offset];
  }

  next(): string | undefined {
    const c = this.peek();
    this.pos += 1;
    return c;
  }

  eat(c: string): boolean {
    if (this.peek() === c) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  alternation(): Node {
    const branches = [this.concat()];
    while (this.eat("|")) branches.push(this.concat());
    return branches.length === 1 ? (branches[0] ?? EMPTY) : { kind: "alt", items: branches };
  }

  concat(): Node {
    const items: Node[] = [];
    for (let c = this.peek(); c !== undefined && c !== "|" && c !== ")"; c = this.peek()) {
      items.push(this.term());
    }
    if (items.length === 0) return EMPTY;
    return items.length === 1 ? (items[0] ?? EMPTY) : { kind: "concat", items };
  }

  term(): Node {
    const atom = this.atom();
    const quantifier = this.quantifier();
    if (!quantifier) return atom;
    // Unicode mode: assertions and lookaheads cannot be repeated.
    if (["start", "end", "boundary", "look"].includes(atom.kind)) throw unsupported();
    const lazy = this.eat("?");
    return { kind: "repeat", body: atom, min: quantifier[0], max: quantifier[1], lazy };
  }

  /** A quantifier, if one follows: `*`, `+`, `?`, `{n}`, `{n,}`, `{n,m}`. */
  quantifier(): [number, number | null] | null {
    switch (this.peek()) {
      case "*":
        this.pos += 1;
        return [0, null];
      case "+":
        this.pos += 1;
        return [1, null];
      case "?":
        this.pos += 1;
        return [0, 1];
      case "{": {
        this.pos += 1;
        const min = this.digits();
        if (min === null) throw unsupported();
        let max: number | null = min;
        if (this.eat(",")) {
          if (this.peek() === "}") {
            max = null;
          } else {
            max = this.digits();
            if (max === null) throw unsupported();
          }
        }
        if (!this.eat("}")) throw unsupported();
        if (max !== null && max < min) throw unsupported();
        return [min, max];
      }
      default:
        return null;
    }
  }

  digits(): number | null {
    const start = this.pos;
    while (isDigit(this.peek())) this.pos += 1;
    if (this.pos === start) return null;
    const value = Number(this.chars.slice(start, this.pos).join(""));
    return value > U32_MAX ? U32_MAX : value;
  }

  atom(): Node {
    const c = this.next();
    switch (c) {
      case undefined:
        throw unsupported();
      case "^":
        return { kind: "start" };
      case "$":
        return { kind: "end" };
      case ".":
        return setNode(DOT);
      case "(":
        return this.group();
      case "[":
        return setNode(this.charClass());
      case "\\":
        return this.escape();
      case ")":
      case "]":
      case "{":
      case "}":
      case "*":
      case "+":
      case "?":
        throw unsupported();
      default:
        return setNode(single(c.codePointAt(0) ?? 0));
    }
  }

  group(): Node {
    let capturing = true;
    let look: boolean | null = null;
    if (this.eat("?")) {
      capturing = false;
      const kind = this.next();
      if (kind === "=") look = false;
      else if (kind === "!") look = true;
      // Lookbehind `(?<=`/`(?<!`, named groups `(?<name>`, and inline flags `(?i)` are all
      // outside the dialect.
      else if (kind !== ":") throw unsupported();
    }
    const body = this.alternation();
    if (!this.eat(")")) throw unsupported();
    return look === null
      ? { kind: "group", capturing, body }
      : { kind: "look", negated: look, body };
  }

  /** An escape outside a class. */
  escape(): Node {
    const c = this.next();
    if (c === undefined) throw unsupported();
    if (c === "b") return { kind: "boundary", negated: false };
    if (c === "B") return { kind: "boundary", negated: true };
    if (c === "-") throw unsupported();
    return setNode(this.escapeSet(c, false));
  }

  /** The set an escape stands for (`c` is the character after `\`). */
  escapeSet(c: string, inClass: boolean): CharSet {
    switch (c) {
      case "d":
        return DIGIT;
      case "D":
        return negate(DIGIT);
      case "w":
        return WORD;
      case "W":
        return negate(WORD);
      case "s":
        return SPACE;
      case "S":
        return negate(SPACE);
      case "t":
        return single(0x09);
      case "n":
        return single(0x0a);
      case "v":
        return single(0x0b);
      case "f":
        return single(0x0c);
      case "r":
        return single(0x0d);
      case "0":
        // Legacy octal.
        if (isDigit(this.peek())) throw unsupported();
        return single(0);
      case "x":
        return single(this.hex(2));
      case "u":
        return this.unicodeEscape();
    }
    if (inClass && c === "b") return single(0x08);
    if (inClass && c === "-") return single(0x2d);
    if (SYNTAX.includes(c)) return single(c.codePointAt(0) ?? 0);
    // Backreferences `\1`-`\9` and `\k<name>`, `\p{...}`, `\cX`, and every other identity escape
    // are outside the dialect.
    throw unsupported();
  }

  hex(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const c = this.next();
      if (!isHex(c)) throw unsupported();
      value = value * 16 + parseInt(c ?? "", 16);
    }
    return value;
  }

  /** `\uHHHH` (a surrogate pair written as two escapes is one code point), or `\u{H...}`. */
  unicodeEscape(): CharSet {
    let code: number;
    if (this.eat("{")) {
      const start = this.pos;
      while (isHex(this.peek())) this.pos += 1;
      const text = this.chars.slice(start, this.pos).join("");
      if (text === "" || !this.eat("}")) throw unsupported();
      code = parseInt(text, 16);
      if (code > MAX_CODE_POINT) throw unsupported();
    } else {
      const high = this.hex(4);
      code = high;
      if (high >= 0xd800 && high <= 0xdbff && this.peek() === "\\" && this.peek(1) === "u") {
        const save = this.pos;
        this.pos += 2;
        try {
          const low = this.hex(4);
          if (low >= 0xdc00 && low <= 0xdfff) {
            code = 0x10000 + ((high - 0xd800) << 10) + (low - 0xdc00);
          } else {
            this.pos = save;
          }
        } catch {
          this.pos = save;
        }
      }
    }
    // A lone surrogate matches nothing, as in agent86's runtime (no Rust string holds one).
    if (code >= 0xd800 && code <= 0xdfff) return [];
    return single(code);
  }

  /** A character class, after its `[`. */
  charClass(): CharSet {
    const negated = this.eat("^");
    let set: CharSet = [];
    for (;;) {
      const c = this.next();
      if (c === undefined) throw unsupported();
      if (c === "]") break;
      const first = this.classAtom(c);
      const after = this.peek(1);
      if (this.peek() === "-" && after !== undefined && after !== "]") {
        this.pos += 1;
        const second = this.classAtom(this.next() ?? "");
        const lo = only(first);
        const hi = only(second);
        if (lo === null || hi === null || lo > hi) throw unsupported();
        set = union(set, [[lo, hi]]);
      } else {
        set = union(set, first);
      }
    }
    return negated ? negate(set) : set;
  }

  classAtom(c: string): CharSet {
    if (c !== "\\") return single(c.codePointAt(0) ?? 0);
    const escaped = this.next();
    if (escaped === undefined || escaped === "B") throw unsupported();
    return this.escapeSet(escaped, true);
  }
}

/** The one code point a set holds, if it holds exactly one. */
function only(set: CharSet): number | null {
  const [range, ...rest] = set;
  return range && rest.length === 0 && range[0] === range[1] ? range[0] : null;
}

function unbounded(node: Node): boolean {
  switch (node.kind) {
    case "repeat":
      return node.max === null || unbounded(node.body);
    case "look":
    case "group":
      return unbounded(node.body);
    case "concat":
    case "alt":
      return node.items.some(unbounded);
    default:
      return false;
  }
}

function nullable(node: Node): boolean {
  switch (node.kind) {
    case "empty":
    case "start":
    case "end":
    case "boundary":
    case "look":
      return true;
    case "set":
      return false;
    case "group":
      return nullable(node.body);
    case "repeat":
      return node.min === 0 || nullable(node.body);
    case "concat":
      return node.items.every(nullable);
    case "alt":
      return node.items.some(nullable);
  }
}

/** The characters a node's match can start with. */
function first(node: Node): CharSet {
  switch (node.kind) {
    case "set":
      return node.set;
    case "group":
    case "repeat":
      return first(node.body);
    case "concat": {
      let set: CharSet = [];
      for (const item of node.items) {
        set = union(set, first(item));
        if (!nullable(item)) break;
      }
      return set;
    }
    case "alt":
      return node.items.reduce<CharSet>((set, item) => union(set, first(item)), []);
    default:
      return [];
  }
}

function unwrapGroups(node: Node): Node {
  let current = node;
  while (current.kind === "group") current = current.body;
  return current;
}

/** The character set of an unbounded-repeated atom, for rule 4: a repeated single-character atom,
 * or a group whose only content is one (a group holding just `\d+` counts as `\d+`). */
function unboundedAtom(node: Node): CharSet | null {
  const inner = unwrapGroups(node);
  if (inner.kind !== "repeat" || inner.max !== null) return null;
  const body = unwrapGroups(inner.body);
  return body.kind === "set" ? body.set : null;
}

function check(node: Node): void {
  switch (node.kind) {
    case "repeat": {
      if ((node.max === null || node.max > 1) && unbounded(node.body)) {
        throw new Refused("NESTED_QUANTIFIER");
      }
      const body = unwrapGroups(node.body);
      if (node.max === null && body.kind === "alt") {
        const firsts = body.items.map(first);
        firsts.forEach((a, i) => {
          if (firsts.slice(i + 1).some((b) => overlaps(a, b))) {
            throw new Refused("OVERLAPPING_ALTERNATION");
          }
        });
      }
      check(node.body);
      return;
    }
    case "concat": {
      node.items.forEach((item, i) => {
        const set = unboundedAtom(item);
        if (!set) return;
        for (const later of node.items.slice(i + 1)) {
          const other = unboundedAtom(later);
          if (other && overlaps(set, other)) throw new Refused("ADJACENT_OVERLAP");
          if (!nullable(later)) break;
        }
      });
      node.items.forEach(check);
      return;
    }
    case "alt":
      node.items.forEach(check);
      return;
    case "look":
    case "group":
      check(node.body);
      return;
    default:
      return;
  }
}

const hexOf = (n: number) => n.toString(16).toUpperCase();

function emitSet(set: CharSet): string {
  // An empty set matches nothing.
  if (set.length === 0) return "(?!)";
  const ranges = set.map(([lo, hi]) =>
    lo === hi ? `\\u{${hexOf(lo)}}` : `\\u{${hexOf(lo)}}-\\u{${hexOf(hi)}}`,
  );
  return `[${ranges.join("")}]`;
}

function emit(node: Node): string {
  switch (node.kind) {
    case "empty":
      return "";
    case "set":
      return emitSet(node.set);
    // No `m` flag: `^` and `$` are the input's ends (`$` not before a final newline).
    case "start":
      return "^";
    case "end":
      return "$";
    // With `u` and no `i`, JavaScript's `\b` uses the ASCII word characters, as the dialect does.
    case "boundary":
      return node.negated ? "\\B" : "\\b";
    case "look":
      return `${node.negated ? "(?!" : "(?="}${emit(node.body)})`;
    case "group":
      return `${node.capturing ? "(" : "(?:"}${emit(node.body)})`;
    case "concat":
      return node.items.map(emit).join("");
    case "alt":
      return `(?:${node.items.map(emit).join("|")})`;
    case "repeat": {
      const count = node.max === null ? `{${node.min},}` : `{${node.min},${node.max}}`;
      return `(?:${emit(node.body)})${count}${node.lazy ? "?" : ""}`;
    }
  }
}

/** A pattern that passed the dialect's checks. */
export class Pattern {
  private readonly regex: RegExp;

  private constructor(regex: RegExp) {
    this.regex = regex;
  }

  /** Parse and check `pattern`: the compiled pattern, or the specification's reason it is refused
   * (outside the dialect, or unsafe). */
  static compile(pattern: string): Pattern | Refusal {
    if (Array.from(pattern).length > MAX_PATTERN_CODE_POINTS) return "PATTERN_TOO_LONG";
    try {
      const parser = new Parser(pattern);
      const node = parser.alternation();
      // A `)` with no group open.
      if (parser.pos < parser.chars.length) return "UNSUPPORTED_SYNTAX";
      check(node);
      return new Pattern(new RegExp(emit(node), "u"));
    } catch (error) {
      if (error instanceof Refused) return error.refusal;
      // `RegExp` refused what the dialect accepted: treat it as outside the dialect.
      return "UNSUPPORTED_SYNTAX";
    }
  }

  /** Whether the pattern matches anywhere in `value` (`RegExp.test`). A value longer than
   * MAX_VALUE_CODE_POINTS does not match. */
  test(value: string): boolean {
    if (Array.from(value).length > MAX_VALUE_CODE_POINTS) return false;
    return this.regex.test(value);
  }
}
