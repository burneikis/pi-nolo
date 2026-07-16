import { resolve as resolvePath, normalize as normalizePath } from "node:path";
import {
  STDOUT_REDIRECT_RE,
  PREFIX_DANGEROUS_FLAGS,
  DYNAMIC_ARGUMENT_UNSAFE_PREFIXES,
  XARGS_SAFE_PREFIXES,
} from "./config.js";

// --- xargs command extractor ---

// xargs flags that consume the next token as their argument.
const XARGS_FLAGS_WITH_ARGS = new Set([
  "-n", "-P", "-I", "-L", "-d", "-a",
  "--max-args", "--max-procs", "--replace", "--max-lines",
  "--delimiter", "--arg-file",
]);

/**
 * Given a segment that starts with "xargs", return the command xargs will run
 * (i.e. the first non-flag token after xargs and its own flags), or null if
 * xargs is being called with no explicit command (uses echo by default, safe).
 */
export function getXargsCommand(segment: string): string | null {
  const rest = segment.slice("xargs".length).trim();
  if (!rest) return null;
  const tokens = rest.split(/\s+/);
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (!tok.startsWith("-")) break;
    // Flags like -n1 or -P4 embed their argument -- no extra token to skip.
    // Flags like -n 1 or -I {} consume the next token.
    const bare = tok.split("=")[0]; // handle --flag=value form
    if (XARGS_FLAGS_WITH_ARGS.has(bare) && !tok.includes("=")) {
      i += 2;
    } else {
      i += 1;
    }
  }
  return i < tokens.length ? tokens[i] : null;
}

// --- Quote-aware shell operator splitter ---

export type ShellOperator = "|" | "||" | "&&" | ";";

export interface CommandSegment {
  text: string;
  /** Operator between this segment and the previous one; null for the first. */
  prevOp: ShellOperator | null;
}

/**
 * Splits a command on |, ||, &&, and ; keeping the operator that precedes
 * each segment. Operators inside single or double quoted strings are ignored,
 * preventing false splits on grep patterns like "foo\|bar" or awk programs
 * like '{print $1|"sort"}'.
 */
export function splitOnShellOperatorsWithOps(command: string): CommandSegment[] {
  const segments: CommandSegment[] = [];
  let current = "";
  let prevOp: ShellOperator | null = null;
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  const push = (op: ShellOperator | null) => {
    segments.push({ text: current, prevOp });
    current = "";
    prevOp = op as ShellOperator | null;
  };

  while (i < command.length) {
    const ch = command[i];

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      i++;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      i++;
    } else if (!inSingle && !inDouble) {
      if (ch === "\\" && command[i + 1] === "\n") {
        // Backslash-newline is a line continuation, not a separator.
        current += " ";
        i += 2;
      } else if (command.startsWith("||", i)) {
        push("||");
        i += 2;
      } else if (command.startsWith("&&", i)) {
        push("&&");
        i += 2;
      } else if (ch === "|") {
        push("|");
        i++;
      } else if (ch === ";") {
        push(";");
        i++;
      } else if (ch === "\n") {
        // A bare newline separates commands exactly like `;`. Without this,
        // anything after a newline would piggyback on the first line's prefix
        // match (e.g. "ls\ncurl ..." would be auto-approved).
        push(";");
        i++;
      } else {
        current += ch;
        i++;
      }
    } else {
      current += ch;
      i++;
    }
  }

  if (current) segments.push({ text: current, prevOp });
  return segments;
}

/**
 * Splits a command on |, ||, &&, and ; but ignores operators that appear
 * inside single or double quoted strings.
 */
export function splitOnShellOperators(command: string): string[] {
  return splitOnShellOperatorsWithOps(command).map((s) => s.text);
}

// --- cd tracking ---

// Literal cd target: path chars only -- no spaces, quotes, `$`, `~`, or
// backslashes, so the resolved directory is knowable statically.
const CD_ARG_RE = /^[A-Za-z0-9_@%+=:,.\/-]+$/;

/**
 * Returns the working directory after a `cd` segment, or null when it cannot
 * be determined statically. `prevCwd` is the tracked directory before the cd
 * (used to resolve relative targets).
 */
function trackCd(clean: string, prevCwd: string | null): string | null {
  const arg = clean.slice(2).trim();
  if (!arg) return null; // bare cd (home) -- do not track
  if (arg.includes(SUBST_PLACEHOLDER)) return null;
  if (!CD_ARG_RE.test(arg)) return null;
  if (arg.startsWith("/")) return normalizePath(arg);
  if (prevCwd) return resolvePath(prevCwd, arg);
  return null;
}

// --- Command substitutions ---

interface SubstSpan {
  start: number; // index of "$("
  end: number;   // index just past the matching ")"
  inner: string; // command between the parens
}

// Inert stand-in for a validated substitution. Letters/underscores only so it
// can never match a safe prefix, trip a dangerous pattern, or parse as a shell
// operator; if a substitution is used as the command word itself, the
// placeholder fails prefix matching and the command still requires confirmation.
const SUBST_PLACEHOLDER = "__nolo_subst__";

// Guard against pathological nesting when recursively validating inner commands.
const MAX_SUBST_DEPTH = 5;

/**
 * Extracts top-level `$(...)` spans, ignoring ones inside single quotes
 * (where the shell treats them literally) and tracking quotes and paren depth
 * inside each substitution. Returns null when a substitution is unbalanced.
 */
export function extractCommandSubstitutions(command: string): SubstSpan[] | null {
  const spans: SubstSpan[] = [];
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  while (i < command.length) {
    const ch = command[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      i++;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      i++;
    } else if (!inSingle && command.startsWith("$(", i)) {
      let depth = 1;
      let j = i + 2;
      let s = false;
      let d = false;
      while (j < command.length && depth > 0) {
        const c = command[j];
        if (c === "'" && !d) s = !s;
        else if (c === '"' && !s) d = !d;
        else if (!s) {
          if (c === "(") depth++;
          else if (c === ")") depth--;
        }
        j++;
      }
      if (depth !== 0) return null;
      spans.push({ start: i, end: j, inner: command.slice(i + 2, j - 1) });
      i = j;
    } else {
      i++;
    }
  }

  return spans;
}

// --- Simple variable assignments ---

// A standalone segment like `D=/path/to/dir` with a literal value: no spaces,
// quotes, `$`, or backslashes (command substitution and redirects are already
// rejected globally before segments are examined).
const ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_@%+=:,.\/~-]*)$/;

/**
 * Expands `$NAME` / `${NAME}` occurrences for variables assigned earlier in
 * the same command. Unknown variables are left untouched (and will then fail
 * prefix matching, forcing confirmation).
 */
export function expandVars(segment: string, vars: Map<string, string>): string {
  if (vars.size === 0) return segment;
  let out = segment;
  for (const [name, value] of vars) {
    out = out.split("${" + name + "}").join(value);
    out = out.replace(new RegExp("\\$" + name + "(?![A-Za-z0-9_])", "g"), value);
  }
  return out;
}

// --- Prefix semantic checks ---

/**
 * `git branch NAME` and `git tag NAME` mutate refs without requiring a
 * dangerous-looking flag. Flag-driven mutation forms are handled by
 * PREFIX_DANGEROUS_FLAGS; this catches the plain positional creation form.
 */
function isPlainGitRefCreation(clean: string, prefix: string): boolean {
  if (prefix !== "git branch" && prefix !== "git tag") return false;
  const rest = clean.slice(prefix.length).trim();
  if (!rest) return false;
  // A first positional token creates a branch/lightweight tag. `-- NAME` is
  // the same form with option parsing terminated explicitly.
  return !rest.startsWith("-") || /^--\s+\S/.test(rest);
}

// --- sed read-only validation ---

// Combinable short flags that cannot change sed's read-only nature:
// -n (quiet), -u (unbuffered), -z (null-data), -s (separate), -E/-r (ERE).
const SED_SAFE_SHORT_FLAG_RE = /^-[nuzsEr]+$/;
const SED_SAFE_LONG_FLAGS = new Set([
  "--quiet", "--silent", "--unbuffered", "--null-data", "--separate",
  "--regexp-extended", "--posix", "--sandbox",
]);

// Read-only sed script grammar: optional numeric / last-line ($) addresses
// followed by p (print), d (delete from stream), = (line number), or q
// (quit, optional exit code); atoms may be joined with `;`. This excludes by
// construction everything that can write or execute: w/W and s///w (write
// files), e and s///e (run commands), r/R and regex addresses (kept out to
// stay minimal and unambiguous), and s in general.
const SED_ADDR = String.raw`(?:\d+(?:~\d+)?|\$)(?:,(?:\d+|\$))?`;
const SED_ATOM = `(?:${SED_ADDR}\\s*)?(?:[pd=]|q\\d*)`;
const SED_SCRIPT_RE = new RegExp(`^\\s*${SED_ATOM}(?:\\s*;\\s*${SED_ATOM})*\\s*;?\\s*$`);

/**
 * Splits a segment into whitespace-separated tokens with surrounding single
 * or double quotes removed (quoted spans may contain whitespace). Returns
 * null on unbalanced quotes.
 */
function tokenizeQuoted(segment: string): string[] | null {
  const tokens: string[] = [];
  let cur = "";
  let started = false;
  let i = 0;
  while (i < segment.length) {
    const ch = segment[i];
    if (ch === "'" || ch === '"') {
      const close = segment.indexOf(ch, i + 1);
      if (close === -1) return null;
      cur += segment.slice(i + 1, close);
      started = true;
      i = close + 1;
    } else if (/\s/.test(ch)) {
      if (started) {
        tokens.push(cur);
        cur = "";
        started = false;
      }
      i++;
    } else {
      cur += ch;
      started = true;
      i++;
    }
  }
  if (started) tokens.push(cur);
  return tokens;
}

/**
 * Returns true when a `sed` segment is provably read-only: every flag is in
 * the safe set, every script (positional or via -e/--expression) matches the
 * restricted print/quit grammar, and no other option appears anywhere --
 * including after filenames, since GNU sed permutes arguments, so a literal
 * `-i` at the end would still edit in place.
 */
export function isReadOnlySedSegment(segment: string): boolean {
  // Fail closed on backslashes: escaping could smuggle quotes or newlines
  // past the simple tokenizer above.
  if (segment.includes("\\")) return false;
  const tokens = tokenizeQuoted(segment);
  if (!tokens || tokens[0] !== "sed") return false;

  let script: string | null = null;
  let sawDashDash = false;

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!sawDashDash && tok === "--") {
      sawDashDash = true;
      continue;
    }
    if (!sawDashDash && tok.startsWith("-") && tok !== "-") {
      if (tok === "-e" || tok === "--expression") {
        const expr = tokens[++i];
        if (expr === undefined || !SED_SCRIPT_RE.test(expr)) return false;
        script = expr;
        continue;
      }
      if (tok.startsWith("--expression=")) {
        const expr = tok.slice("--expression=".length);
        if (!SED_SCRIPT_RE.test(expr)) return false;
        script = expr;
        continue;
      }
      if (SED_SAFE_SHORT_FLAG_RE.test(tok) || SED_SAFE_LONG_FLAGS.has(tok)) continue;
      // Anything else (-i, -f, unknown flags) requires confirmation.
      return false;
    }
    // First positional token is the script; the rest are input files.
    if (script === null) {
      if (!SED_SCRIPT_RE.test(tok)) return false;
      script = tok;
    }
  }

  return script !== null;
}

// --- Safety check ---

/**
 * Returns true if the command is considered safe (read-only) and should be
 * auto-approved without user confirmation.
 *
 * A command is safe when every segment (split on |, &&, ||, ;) starts with a
 * known safe prefix and the command contains no stdout redirects or unsafe
 * constructs. Two layers of dangerous-pattern checks are applied:
 *   global  -- checked on the full command string (backticks, $(), rm, sudo, eval, source)
 *   segment -- checked per segment (sh/bash as commands, find -exec/-delete, system() calls)
 * Stderr redirects such as 2>/dev/null are allowed.
 *
 * Standalone assignment segments with literal values (e.g. `D=/path`) are
 * treated as safe, and `$D` / `${D}` in later segments is expanded to the
 * assigned value before prefix matching, so `D=/x; $D/tool.sh` is judged
 * exactly like `/x/tool.sh`.
 *
 * Command substitutions `$(...)` are validated recursively: when every inner
 * command is itself safe, the spans are replaced with an inert placeholder and
 * the outer command is checked as usual (substitution output is only ever
 * word-split by the shell, never re-parsed for operators, so a safe inner
 * command's output can only become arguments). Any unsafe, empty, or
 * unbalanced substitution fails the check. Backticks are always unsafe.
 *
 * `cd <literal-dir>` is tracked so that a later `./x` or `../x` command word
 * can be resolved to an absolute path before prefix matching. The tracked
 * directory always survives `&&` boundaries (the shell guarantees the cd
 * succeeded in the main shell). It additionally survives `;` when the target
 * was verified via opts.isExecutableDir at check time -- a verified cd cannot
 * fail, so post-`;` segments really do run there. `|` and `||` always
 * invalidate (subshelled or conditionally-skipped cds are independent of
 * whether the directory exists).
 */
export interface SafeCommandOptions {
  /**
   * Returns true when the path is an existing, traversable directory.
   * Enables keeping the tracked cwd across `;` boundaries.
   */
  isExecutableDir?: (path: string) => boolean;
}

export function isSafeCommand(
  command: string,
  safePrefixes: string[],
  dangerousRegexes: RegExp[],
  segmentDangerousRegexes: RegExp[],
  opts: SafeCommandOptions = {},
  depth = 0,
): boolean {
  let trimmed = command.trim();

  // Command substitutions: recursively validate inner commands; if all are
  // safe, replace the spans with a placeholder so downstream checks treat them
  // as opaque arguments. Otherwise leave the string untouched so the global
  // `\$\(` dangerous pattern rejects it below.
  const spans = extractCommandSubstitutions(trimmed);
  if (spans === null) return false;
  // Fail closed at the recursion cap independently of configurable dangerous
  // patterns; otherwise removing the default `\$\(` regex could let deeply
  // nested substitutions bypass recursive validation.
  if (spans.length > 0 && depth >= MAX_SUBST_DEPTH) return false;
  if (spans.length > 0) {
    for (const span of spans) {
      if (
        !isSafeCommand(span.inner, safePrefixes, dangerousRegexes, segmentDangerousRegexes, opts, depth + 1)
      ) {
        return false;
      }
    }
    for (let i = spans.length - 1; i >= 0; i--) {
      trimmed = trimmed.slice(0, spans[i].start) + SUBST_PLACEHOLDER + trimmed.slice(spans[i].end);
    }
  }

  // Global check: constructs dangerous regardless of context.
  for (const re of dangerousRegexes) {
    if (re.test(trimmed)) return false;
  }

  // Block stdout redirects (writes to files). Only 2> (stderr) is exempted.
  if (STDOUT_REDIRECT_RE.test(trimmed)) return false;

  // Split compound commands on shell operators and verify every segment
  // individually. A compound read-only command like
  //   ls foo && cat bar | head -20 2>/dev/null
  // is safe as long as each segment (ls, cat, head) is a safe prefix.
  const segments = splitOnShellOperatorsWithOps(trimmed);
  if (segments.every((s) => !s.text.trim())) return false;

  const vars = new Map<string, string>();
  let cwd: string | null = null;
  let cwdVerified = false;

  for (const { text, prevOp } of segments) {
    // A tracked cwd always survives && boundaries. It survives `;` only when
    // the cd target was fs-verified (a verified cd cannot fail, so post-`;`
    // segments really run there). `|` / `||` always invalidate: the cd may
    // have run in a subshell or been skipped regardless of the filesystem.
    if (prevOp !== null && prevOp !== "&&" && !(prevOp === ";" && cwdVerified)) {
      cwd = null;
      cwdVerified = false;
    }

    // Expand variables assigned earlier in this command before any checks.
    const expanded = expandVars(text, vars);

    // Strip fd/stderr redirects (e.g. 2>/dev/null, 2>&1) before checks.
    let clean = expanded.replace(/\s+\d*>(?:&\d+|\S*)/g, "").trim();
    if (!clean) continue;

    // Standalone literal assignment: record it and treat the segment as safe.
    const assign = clean.match(ASSIGNMENT_RE);
    if (assign) {
      vars.set(assign[1], assign[2]);
      continue;
    }

    // Track cd targets (the segment itself still goes through prefix checks).
    // A cd preceded by | or || runs in a subshell or conditionally, so its
    // target must not be trusted; cwd was already invalidated above.
    if (clean === "cd" || clean.startsWith("cd ")) {
      cwd = prevOp === "|" || prevOp === "||" ? null : trackCd(clean, cwd);
      cwdVerified = cwd !== null && opts.isExecutableDir?.(cwd) === true;
    } else if (cwd && (clean.startsWith("./") || clean.startsWith("../"))) {
      // Resolve a relative command word against the tracked directory so it
      // can match absolute-path safe prefixes.
      const sp = clean.search(/\s/);
      const word = sp === -1 ? clean : clean.slice(0, sp);
      clean = resolvePath(cwd, word) + (sp === -1 ? "" : clean.slice(sp));
    }

    // Segment check: dangerous flags or calls within otherwise-safe commands.
    // Applied here (not globally) to avoid false positives on filenames and
    // arguments -- e.g. \bsh\b would fire on deploy.sh in a git show argument.
    for (const re of segmentDangerousRegexes) {
      if (re.test(clean)) return false;
    }

    let matchedPrefix: string | null = null;
    let isXargs = false;

    // xargs input becomes runtime arguments, so it may only invoke a narrower
    // set of argument-safe commands. Allowing every normal prefix here would
    // permit inputs like "-delete" to turn `xargs find` into a mutation.
    if (clean === "xargs" || clean.startsWith("xargs ")) {
      isXargs = true;
      const sub = getXargsCommand(clean);
      // No explicit command means xargs uses echo.
      if (sub === null) {
        matchedPrefix = "echo";
      } else if (XARGS_SAFE_PREFIXES.has(sub) && safePrefixes.includes(sub)) {
        matchedPrefix = sub;
      }
    }

    if (!matchedPrefix && !isXargs) {
      for (const prefix of safePrefixes) {
        if (clean === prefix || clean.startsWith(prefix + " ")) {
          matchedPrefix = prefix;
          break;
        }
      }
    }

    if (!matchedPrefix) return false;

    // Check prefix-specific literal flags and mutation forms before accepting.
    const flags = PREFIX_DANGEROUS_FLAGS[matchedPrefix];
    if (flags?.some((re) => re.test(clean))) return false;
    if (isPlainGitRefCreation(clean, matchedPrefix)) return false;
    if (matchedPrefix === "sed" && !isReadOnlySedSegment(clean)) return false;

    // A validated substitution is still opaque: its runtime output can become
    // an option. For commands with write/exec-capable options, force a prompt
    // rather than let a placeholder hide a flag (e.g. sort $(echo -o)).
    if (
      clean.includes(SUBST_PLACEHOLDER) &&
      DYNAMIC_ARGUMENT_UNSAFE_PREFIXES.has(matchedPrefix)
    ) {
      return false;
    }
  }

  return true;
}
