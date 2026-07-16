# pi-nolo

No-YOLO mode for [pi-coding-agent](https://github.com/nichochar/pi-mono). Gates `write`, `edit`, and `bash` tool calls behind user confirmation — press Enter to allow, Escape to block.

Read-safe bash commands (`ls`, `grep`, `git status`, etc.) are auto-approved via a configurable allowlist, so you only get prompted for commands that could mutate state.

## Install

```bash
pi install npm:pi-nolo
```

Or from git:

```bash
pi install https://github.com/burneikis/pi-nolo
```

### Note:

The default YOLO-cycle shortcut is `ctrl+y`, which conflicts with pi's built-in `tui.editor.yank`. Instead of editing pi's `keybindings.json`, you can move the extension's shortcut by setting `"shortcut": "ctrl+shift+y"` in your `nolo.json` (see [Configuration](#configuration)). Changing it takes effect after a `/reload`.

## What it does

Every time the agent tries to:

- **Write a file** — confirms with the file path and line count
- **Edit a file** — confirms with the file path; shows a pre-rendered diff preview before the tool finishes executing
- **Run a bash command** — auto-approves safe read-only commands; confirms everything else

You get a dialog: Enter to allow, Escape to block.

In non-interactive mode (no UI, e.g. `pi -p` or `--mode json`) nothing is gated by default, since there is no way to confirm. Enable **strict non-interactive** mode to instantly block anything that would have required confirmation instead:

- **Config:** set `"strictNonInteractive": true` in `nolo.json` (project overrides global).
- **Env var:** `NOLO_STRICT=1` (or `true`) enables it, `NOLO_STRICT=0` disables it; the env var overrides config.

With strict mode on, `write`/`edit` calls and non-read-only bash commands are blocked with a clear reason; safe read-only bash commands still run. Example:

```bash
NOLO_STRICT=1 pi -p "Review the code in src/"
```

## Pre-rendered edit diffs

As of pi ~0.63.0, the built-in edit tool only shows diffs after execution. This extension includes a built-in pre-renderer (ported from [pi-pre-render-edit](https://github.com/burneikis/pi-pre-render-edit)) that computes and displays the diff as soon as the tool arguments are complete -- before the edit is applied. This means you can see exactly what will change while the confirmation dialog is open.

If you previously installed `pi-pre-render-edit` separately, you can remove it -- the functionality is now bundled here.

## YOLO modes

Use `/yolo` to cycle through three modes at any time during a session:

| Mode            | Footer label | Write/Edit     | Bash                              |
| --------------- | ------------ | -------------- | --------------------------------- |
| `off` (default) | `nolo`       | confirm        | confirm (safe cmds auto-approved) |
| `writes`        | `writes`     | **auto-allow** | confirm (safe cmds auto-approved) |
| `full`          | `yolo`       | **auto-allow** | **auto-allow**                    |

Each `/yolo` invocation advances to the next mode and wraps back around:

```
off → writes-yolo → full-yolo → off → …
```

The current mode is shown in the footer status bar. It is also persisted in the session so it survives a `/reload`.

### When to use each mode

- **`writes`** — you trust the edits but still want a gate on shell commands.
- **`full`** — you want the agent to run completely hands-free. Use with caution.

## Scope writes to the project root

In `writes` mode, write/edit calls are normally auto-approved anywhere on disk. **Scope-writes** narrows this: when on, `writes` mode still confirms any write/edit whose path resolves **outside the project root** (`cwd`), so the agent can't silently edit files elsewhere. `off` and `full` modes are unaffected.

- **Config default:** set `"defaultScopeWrites": true` in `nolo.json` (project overrides global overrides the built-in default of `false`).
- **Toggle live:** run `/scopewrites` at any time during a session to flip it. The choice is persisted in the session so it survives a `/reload`.

| scope-writes | `writes` mode write inside root | `writes` mode write outside root |
| ------------ | ------------------------------- | -------------------------------- |
| off (default)| **auto-allow**                  | **auto-allow**                   |
| on           | **auto-allow**                  | confirm                          |

## Bash Command Allowlist

Safe commands are auto-approved without a confirmation dialog. A command is considered safe when:

1. Every shell segment starts with a recognized safe prefix (e.g., `ls`, `grep`, `git status`)
2. It does **not** contain dangerous constructs, flags, redirects, or mutation forms
3. Any command substitution is recursively safe and is not supplying an opaque argument to a command whose flags can write or execute

### Default safe prefixes

```
cd, ls, cat, head, tail, wc, find, grep, rg, fd, tree,
file, stat, du, df, which, whoami, pwd, echo, date, uname,
printenv, basename, dirname, realpath, readlink, id, hostname,
md5sum, sha256sum, git status, git log, git diff, git show,
git blame, git ls-files, git branch, git remote, git tag,
git rev-parse, npm list, npm outdated, npm view, node --version,
python --version, cargo --version, rustc --version, go version,
sed, true, false, :, sort, uniq, cut, tr, jq, column, paste,
comm, diff, less, more
```

### sed

`sed` is allowlisted but gated behind a strict read-only script grammar rather than a flag blacklist, because its script language can write files (`w`, `W`, `s///w`) and run commands (`e`, `s///e`) even without `-i`. A sed segment auto-approves only when every script (positional or via `-e`/`--expression`) consists of numeric or `$` (last-line) addresses with the `p`, `d`, `=`, or `q` commands, and every flag is from the read-only set (`-n`, `-u`, `-z`, `-s`, `-E`, `-r` and their long forms). So `sed -n '2400,2480p' file` and `sed 10q file` auto-approve, while `sed -i`, `-f`, `s///`, `w`/`e` commands, regex addresses, backslash escapes, and options appearing after filenames (GNU sed permutes arguments) all prompt.

### Dangerous pattern guard

Even if a command starts with a safe prefix, it will still require confirmation if it contains:

- Backtick command substitution (`` ` ``)
- `$()` command substitution whose inner command is not itself safe
- Redirections (`>`, `>>`)
- Dangerous commands (`rm`, `sudo`, `eval`, `exec`, `source`, `sh`, `bash`)

For example, `ls` is auto-approved but `ls; rm -rf /` will prompt for confirmation.

### Variable assignments

Standalone assignments with literal values are treated as safe segments, and `$NAME` / `${NAME}` references to them are expanded before prefix matching. So `D=/some/dir; $D/tool.sh` is judged exactly like `/some/dir/tool.sh`. Values containing quotes or spaces are not recognized as assignments, and unknown variables are never expanded (such commands fall through to confirmation).

### cd tracking

`cd <literal-dir>` targets are tracked so that a following relative command word (`./x`, `../x`) can be resolved to an absolute path before prefix matching: `cd /skills/phab/scripts && ./tool.sh` is judged exactly like `/skills/phab/scripts/tool.sh`. The tracked directory always survives `&&` boundaries, where the shell guarantees the cd succeeded in the main shell. It also survives `;` and bare-newline boundaries when the target directory is verified to exist (and be traversable) at check time -- a verified cd cannot fail, so the later segments really do run there. `|` and `||` always invalidate the tracked directory: a subshelled or conditionally-skipped cd leaves `./x` pointing at a different, untrusted file regardless of the filesystem. cd targets containing variables, substitutions, quotes, or `~` are never trusted.

Bare newlines are treated as command separators (like `;`) and each line is checked independently; backslash-newline continuations are joined.

### Command substitutions

`$(...)` substitutions are **not executed by the checker**. Their inner command text is validated recursively, then replaced with an inert placeholder solely for static matching. So `WEEK=$(date +%s); echo $WEEK` auto-approves, while `echo $(curl http://x)` confirms. A substitution used as the command word itself always confirms.

Although shell operators in substitution output are not re-parsed, the output can become command options. Built-in prefixes whose options can write or execute (`find`, `fd`, `sort`, `rg`, `date`, selected Git commands, etc.) therefore reject opaque substitution-derived arguments: `sort $(echo -o) ...` confirms. Custom safe prefixes are treated as an explicit assertion that their complete argument surface is safe; wrappers should enforce their own read-only operation guard, as the Phab search wrapper does. Backticks, unsafe/unbalanced/empty substitutions, and arithmetic expansion `$((...))` always confirm.

## Configuration

You can customize the allowlist with a `nolo.json` config file:

- **Project-level:** `.pi/nolo.json` (takes precedence)
- **Global:** `~/.pi/agent/nolo.json`

### Config format

```json
{
  "safePrefixes": ["make build", "docker ps", "kubectl get"],
  "dangerousPatterns": ["\\|", "&&", "\\brm\\b"],
  "shortcut": "ctrl+shift+y"
}
```

### Merge behavior

- **`safePrefixes`** — merged (union of defaults + global + project)
- **`dangerousPatterns`** — overridden (project overrides global overrides defaults)
- **`shortcut`** — overridden (project overrides global overrides default)

If no config files exist, the hardcoded defaults are used. See [`nolo.example.json`](nolo.example.json) for the full default configuration.

### Example: add custom safe commands

Create `.pi/nolo.json` in your project:

```json
{
  "safePrefixes": ["make build", "docker ps", "kubectl get pods"]
}
```

These will be added to the defaults — you don't need to re-list the built-in prefixes.

### Example: relax dangerous patterns

If you want to allow piped commands (at your own risk):

```json
{
  "dangerousPatterns": [
    "&&",
    "\\|\\|",
    ";",
    "`",
    "\\$\\(",
    ">\\s",
    ">>",
    "\\brm\\b",
    "\\bsudo\\b",
    "\\beval\\b",
    "\\bexec\\b"
  ]
}
```

This replaces the defaults entirely, so the `\\|` (pipe) pattern is no longer checked.

### Example: change the YOLO-cycle shortcut

The `shortcut` field sets the key that cycles YOLO mode. It defaults to
`ctrl+y`, which collides with pi's built-in `tui.editor.yank`. To avoid
the conflict without touching pi's `keybindings.json`, pick another key:

```json
{
  "shortcut": "ctrl+shift+y"
}
```

The shortcut is resolved once when the extension loads, so changes take
effect after a `/reload`. The `/yolo` slash command always works
regardless of the configured shortcut.

## License

MIT
