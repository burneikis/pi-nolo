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

In non-interactive mode (no UI), all mutations are blocked by default.

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

1. It starts with a recognized safe prefix (e.g., `ls`, `grep`, `git status`)
2. It does **not** contain any dangerous patterns (pipes, chaining, redirects, etc.)

### Default safe prefixes

```
ls, cat, head, tail, wc, find, grep, rg, fd, tree,
file, stat, du, df, which, whoami, pwd, echo, date, uname,
env, printenv, git status, git log, git diff, git show,
git branch, git remote, git tag, git rev-parse,
npm list, npm outdated, npm view, node --version,
python --version, cargo --version, rustc --version, go version
```

### Dangerous pattern guard

Even if a command starts with a safe prefix, it will still require confirmation if it contains:

- Backtick command substitution (`` ` ``)
- `$()` command substitution whose inner command is not itself safe
- Redirections (`>`, `>>`)
- Dangerous commands (`rm`, `sudo`, `eval`, `exec`, `source`, `sh`, `bash`)

For example, `ls` is auto-approved but `ls; rm -rf /` will prompt for confirmation.

### Variable assignments

Standalone assignments with literal values are treated as safe segments, and `$NAME` / `${NAME}` references to them are expanded before prefix matching. So `D=/some/dir; $D/tool.sh` is judged exactly like `/some/dir/tool.sh`. Values containing quotes or spaces are not recognized as assignments, and unknown variables are never expanded (such commands fall through to confirmation).

### Command substitutions

`$(...)` substitutions are validated recursively: if the inner command is itself safe (e.g. `date`, `whoami`, or an allowlisted script), the substitution is replaced with an inert placeholder and the outer command is checked as usual. So `WEEK=$(date +%s); ls` auto-approves, while `echo $(curl http://x)` confirms. This is sound because the shell only word-splits substitution output - it never re-parses it for operators - so a safe inner command's output can only become arguments; a substitution used as the command word itself always requires confirmation (the placeholder never matches a safe prefix). Backticks, unbalanced or empty substitutions, and arithmetic expansion `$((...))` always require confirmation.

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
