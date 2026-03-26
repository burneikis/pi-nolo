# pi-nolo

No-YOLO mode for [pi-coding-agent](https://github.com/nichochar/pi-mono). Gates `write`, `edit`, and `bash` tool calls behind user confirmation — press Enter to allow, Escape to block.

Read-safe bash commands (`ls`, `grep`, `git status`, etc.) are auto-approved via a configurable allowlist, so you only get prompted for commands that could mutate state.

## Install

```bash
pi install npm:@burneikis/pi-nolo
```

Or from git:

```bash
pi install https://github.com/burneikis/pi-nolo
```

## What it does

Every time the agent tries to:

- **Write a file** — confirms with the file path and line count
- **Edit a file** — confirms with the file path
- **Run a bash command** — auto-approves safe read-only commands; confirms everything else

You get a dialog: Enter to allow, Escape to block.

In non-interactive mode (no UI), all mutations are blocked by default.

## YOLO modes

Use `/yolo` to cycle through three modes at any time during a session:

| Mode | Footer label | Write/Edit | Bash |
|------|-------------|-----------|------|
| `off` (default) | `nolo` | confirm | confirm (safe cmds auto-approved) |
| `writes` | `writes` | **auto-allow** | confirm (safe cmds auto-approved) |
| `full` | `yolo` | **auto-allow** | **auto-allow** |

Each `/yolo` invocation advances to the next mode and wraps back around:

```
off → writes-yolo → full-yolo → off → …
```

The current mode is shown in the footer status bar. It is also persisted in the session so it survives a `/reload`.

### When to use each mode

- **`writes`** — you trust the edits but still want a gate on shell commands.
- **`full`** — you want the agent to run completely hands-free. Use with caution.

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

- Pipes (`|`), chaining (`&&`, `||`, `;`)
- Command substitution (`` ` ``, `$()`)
- Redirections (`>`, `>>`)
- Dangerous commands (`rm`, `sudo`, `eval`, `exec`, `source`, `sh`, `bash`)

For example, `ls` is auto-approved but `ls; rm -rf /` will prompt for confirmation.

## Configuration

You can customize the allowlist with a `nolo.json` config file:

- **Project-level:** `.pi/nolo.json` (takes precedence)
- **Global:** `~/.pi/agent/nolo.json`

### Config format

```json
{
  "safePrefixes": ["make build", "docker ps", "kubectl get"],
  "dangerousPatterns": ["\\|", "&&", "\\brm\\b"]
}
```

### Merge behavior

- **`safePrefixes`** — merged (union of defaults + global + project)
- **`dangerousPatterns`** — overridden (project overrides global overrides defaults)

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
    "&&", "\\|\\|", ";", "`", "\\$\\(",
    ">\\s", ">>",
    "\\brm\\b", "\\bsudo\\b", "\\beval\\b", "\\bexec\\b"
  ]
}
```

This replaces the defaults entirely, so the `\\|` (pipe) pattern is no longer checked.

## License

MIT
