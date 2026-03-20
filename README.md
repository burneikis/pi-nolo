# pi-nolo

No-YOLO mode for [pi-coding-agent](https://github.com/nichochar/pi-mono). Gates `write`, `edit`, and `bash` tool calls behind user confirmation — press Enter to allow, Escape to block.

## Setup

```bash
git clone https://github.com/aburneikis/pi-nolo.git
```

Then load the extension when starting pi:

```bash
pi --extension /path/to/pi-nolo/confirm-all-writes.ts
```

Or copy it into the auto-discovery directory so it loads automatically:

```bash
cp /path/to/pi-nolo/confirm-all-writes.ts ~/.pi/agent/extensions/
```

## What it does

Every time the agent tries to:

- **Write a file** — confirms with the file path and line count
- **Edit a file** — confirms with the file path
- **Run a bash command** — confirms with the command string

You get a dialog: Enter to allow, Escape to block.

In non-interactive mode (no UI), all mutations are blocked by default.

## License

MIT
