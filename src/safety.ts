import { resolve as resolvePath, normalize as normalizePath } from "node:path";
import { STDOUT_REDIRECT_RE, PREFIX_DANGEROUS_FLAGS } from "./config.js";

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
  if (spans.length > 0 && depth < MAX_SUBST_DEPTH) {
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

    let matched = false;

    // xargs is allowed when the command it runs is itself a safe prefix.
    if (clean === "xargs" || clean.startsWith("xargs ")) {
      const sub = getXargsCommand(clean);
      // No explicit command means xargs uses echo -- safe.
      if (sub === null) {
        matched = true;
      } else {
        for (const prefix of safePrefixes) {
          if (sub === prefix || sub.startsWith(prefix + " ")) {
            matched = true;
            break;
          }
        }
      }
    }

    if (!matched) {
      for (const prefix of safePrefixes) {
        if (clean === prefix || clean.startsWith(prefix + " ")) {
          // Check prefix-specific dangerous flags before accepting
          const flags = PREFIX_DANGEROUS_FLAGS[prefix];
          if (flags?.some((re) => re.test(clean))) return false;
          matched = true;
          break;
        }
      }
    }

    if (!matched) return false;
  }

  return true;
}
