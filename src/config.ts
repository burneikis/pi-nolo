import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { NoloConfig } from "./types.js";

// --- Defaults ---

export const DEFAULT_SAFE_PREFIXES = [
  "cd",
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "find",
  "grep",
  "rg",
  "fd",
  "tree",
  "file",
  "stat",
  "du",
  "df",
  "which",
  "whoami",
  "pwd",
  "echo",
  "date",
  "uname",
  "printenv",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "id",
  "hostname",
  "md5sum",
  "sha256sum",
  "git status",
  "git log",
  "git diff",
  "git show",
  "git blame",
  "git ls-files",
  "git branch",
  "git remote",
  "git tag",
  "git rev-parse",
  "npm list",
  "npm outdated",
  "npm view",
  "node --version",
  "python --version",
  "cargo --version",
  "rustc --version",
  "go version",
  // shell built-ins used as no-ops or fallbacks
  "true",
  "false",
  ":",
  // common read-only pipeline filters
  "sort",
  "uniq",
  "cut",
  "tr",
  "jq",
  "column",
  "paste",
  "comm",
  "diff",
  "less",
  "more",
];

// Checked against the full command string before splitting.
// Catches constructs that are dangerous regardless of which command uses them.
export const DEFAULT_DANGEROUS_PATTERNS = [
  "`",          // backtick command substitution
  "\\$\\(",    // $() command substitution
  "\\brm\\b",
  "\\bsudo\\b",
  "\\beval\\b",
  "\\bsource\\b",
];

// Checked against each individual segment after splitting on shell operators.
// Catches dangerous flags or calls that appear within otherwise-safe commands.
// Keeping these per-segment avoids false positives such as \bsh\b matching
// a .sh filename in a git show or grep argument.
export const DEFAULT_SEGMENT_DANGEROUS_PATTERNS = [
  "^sh\\b",                            // sh used as a command
  "^bash\\b",                          // bash used as a command
  "^exec\\b",                          // exec shell builtin
  // find actions that execute, delete, or write directly to a file
  "[ \\t]-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)\\b",
  "[ \\t]-(?:x|X)\\b",                   // fd -x/-X (exec)
  "[ \\t]--(?:exec|exec-batch)\\b",       // fd --exec/--exec-batch
  "\\bsystem\\s*\\(",                  // awk system() call
];

// Per-prefix dangerous flags. These are checked only when a segment matches
// the given safe prefix, avoiding false positives on other commands.
// Patterns are tested against the segment string.
export const PREFIX_DANGEROUS_FLAGS: Record<string, RegExp[]> = {
  "date":        [/\s-s(?:\S*|\s)/, /\s--set(?:=|\s)/],
  "file":        [/\s-C(?:\S*|\s)/, /\s--compile(?:\s|$)/],
  "find":        [/\s-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)\b/],
  "fd":          [/\s-(?:x|X)(?:\s|$)/, /\s--(?:exec|exec-batch)(?:=|\s)/],
  "rg":          [/\s--pre(?:=|\s)/],
  "sort":        [/\s-o(?:\s|\S)/, /\s--output(?:=|\s)/],
  "tree":        [/\s-o(?:\s|\S)/, /\s--output(?:=|\s)/],
  "diff":        [/\s--output(?:=|\s)/],
  "less":        [/\s-[oO](?:\s|\S)/, /\s--log-file(?:=|\s)/],
  "git log":     [/\s--output(?:=|\s)/, /\s--ext-diff(?:\s|$)/, /\s--textconv(?:\s|$)/],
  "git diff":    [/\s--output(?:=|\s)/, /\s--ext-diff(?:\s|$)/, /\s--textconv(?:\s|$)/],
  "git show":    [/\s--output(?:=|\s)/, /\s--ext-diff(?:\s|$)/, /\s--textconv(?:\s|$)/],
  "git branch":  [
    /\s-[dDmMcCft]\b/,
    /\s--(?:delete|move|copy|force|track|no-track|recurse-submodules|edit-description|set-upstream-to|unset-upstream|create-reflog|orphan)\b/,
  ],
  "git remote":  [/\s(?:add|remove|rename|set-url|set-head|prune|update)\b/],
  "git tag":     [
    /\s-[adfsumF]\b/,
    /\s--(?:annotate|delete|force|sign|local-user|message|file|cleanup|create-reflog)\b/,
  ],
};

/**
 * Built-in prefixes whose runtime arguments can turn an otherwise read command
 * into a write or process execution. Any command-substitution placeholder in
 * one of these segments forces confirmation, because its output is unknowable
 * statically and could become a dangerous option (e.g. `sort $(echo -o)`).
 *
 * Custom safe prefixes are not included: adding one is an explicit assertion
 * that its entire argument surface is safe.
 */
export const DYNAMIC_ARGUMENT_UNSAFE_PREFIXES = new Set([
  "date", "file", "find", "fd", "rg", "sort", "tree", "diff", "less",
  "git log", "git diff", "git show", "git branch", "git remote", "git tag",
]);

/**
 * Commands xargs may invoke. xargs input becomes runtime arguments, so only
 * tools whose argument surface cannot write files or execute subprocesses are
 * permitted. In particular, find/fd/sort/rg/git/file are intentionally absent.
 */
export const XARGS_SAFE_PREFIXES = new Set([
  "echo", "cat", "head", "tail", "wc", "grep", "stat", "du", "df",
  "basename", "dirname", "realpath", "readlink", "md5sum", "sha256sum",
  "uniq", "cut", "tr", "column", "paste", "comm",
]);

// Default YOLO-cycle shortcut. Configurable via `shortcut` in nolo.json.
export const DEFAULT_SHORTCUT = "ctrl+y";

// Default for the scope-writes toggle. Configurable via `defaultScopeWrites`.
export const DEFAULT_SCOPE_WRITES = false;

// Matches stdout redirects (> or >>). Only 2> (stderr) is exempted; any other
// fd-prefixed or bare redirect is treated as a potential file write.
export const STDOUT_REDIRECT_RE = /(?<!2)>>?(?!&)/;

// --- Loader ---

function loadJsonFile(path: string): Partial<NoloConfig> | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

export interface LoadedConfig {
  safePrefixes: string[];
  dangerousRegexes: RegExp[];
  segmentDangerousRegexes: RegExp[];
  shortcut: string;
  defaultScopeWrites: boolean;
}

export interface LoadConfigOptions {
  /** Override config roots (primarily for hermetic tests). */
  homeDir?: string;
  projectDir?: string;
}

export function loadConfig(opts: LoadConfigOptions = {}): LoadedConfig {
  const globalPath = join(opts.homeDir ?? homedir(), ".pi", "agent", "nolo.json");
  const projectPath = join(opts.projectDir ?? ".", ".pi", "nolo.json");

  const globalCfg = loadJsonFile(globalPath);
  const projectCfg = loadJsonFile(projectPath);

  // Merge safe prefixes: union of defaults + global + project
  let safePrefixes = [...DEFAULT_SAFE_PREFIXES];
  if (globalCfg?.safePrefixes) {
    safePrefixes = [...new Set([...safePrefixes, ...globalCfg.safePrefixes])];
  }
  if (projectCfg?.safePrefixes) {
    safePrefixes = [...new Set([...safePrefixes, ...projectCfg.safePrefixes])];
  }

  // Dangerous patterns: project overrides global overrides defaults
  let dangerousPatterns: string[] = DEFAULT_DANGEROUS_PATTERNS;
  if (globalCfg?.dangerousPatterns) dangerousPatterns = globalCfg.dangerousPatterns;
  if (projectCfg?.dangerousPatterns) dangerousPatterns = projectCfg.dangerousPatterns;

  // Segment dangerous patterns: same override semantics
  let segmentDangerousPatterns: string[] = DEFAULT_SEGMENT_DANGEROUS_PATTERNS;
  if (globalCfg?.segmentDangerousPatterns) {
    segmentDangerousPatterns = globalCfg.segmentDangerousPatterns;
  }
  if (projectCfg?.segmentDangerousPatterns) {
    segmentDangerousPatterns = projectCfg.segmentDangerousPatterns;
  }

  // Shortcut: project overrides global overrides default. Only accept a
  // non-empty string so malformed values fall back to the default.
  let shortcut = DEFAULT_SHORTCUT;
  if (typeof globalCfg?.shortcut === "string" && globalCfg.shortcut.trim()) {
    shortcut = globalCfg.shortcut;
  }
  if (typeof projectCfg?.shortcut === "string" && projectCfg.shortcut.trim()) {
    shortcut = projectCfg.shortcut;
  }

  // Scope-writes default: project overrides global overrides default.
  let defaultScopeWrites = DEFAULT_SCOPE_WRITES;
  if (typeof globalCfg?.defaultScopeWrites === "boolean") {
    defaultScopeWrites = globalCfg.defaultScopeWrites;
  }
  if (typeof projectCfg?.defaultScopeWrites === "boolean") {
    defaultScopeWrites = projectCfg.defaultScopeWrites;
  }

  return {
    safePrefixes,
    dangerousRegexes: dangerousPatterns.map((p) => new RegExp(p)),
    segmentDangerousRegexes: segmentDangerousPatterns.map((p) => new RegExp(p)),
    shortcut,
    defaultScopeWrites,
  };
}
