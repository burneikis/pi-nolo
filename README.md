# pi-nolo

No-YOLO mode for [pi-coding-agent](https://github.com/nichochar/pi-mono). Gates `write`, `edit`, and `bash` tool calls behind user confirmation — press Enter to allow, Escape to block.

## Quick setup

Clone directly into the pi extensions directory so it loads automatically:

```bash
git clone https://github.com/burneikis/pi-nolo.git ~/.pi/agent/extensions/pi-nolo
```

That's it — pi will discover the extension on next start.

## Alternative setup

Clone wherever you like and load it manually:

```bash
git clone https://github.com/burneikis/pi-nolo.git
pi --extension /path/to/pi-nolo/confirm-all-writes.ts
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
