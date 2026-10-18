# pi-compact-tools

Three tool-row styles for Pi: **Claude**, **Codex**, and **Compact**. Switch styles live, hide tool noise with silent mode, and see what codemode scripts actually called.

**UI only:** no changes to tool execution, model input, or session records. Includes custom-tool rendering and a GitHub Dark theme.

![The same tool calls in Compact, Claude, Codex, then silent mode](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/overview.gif)

## Install

```bash
pi install npm:pi-compact-tools
```

Run `/reload` or restart Pi, then `/compact-tools` to choose a style. Try without installing: `pi -e npm:pi-compact-tools`.

Requires Node.js 22.19+ and Pi 0.85.1+. **Pi 1.0.2+ recommended** for native renderer integration and styled HTML exports.

## Styles

| Style | What you see | Command |
|---|---|---|
| **Claude** | Grouped reads/searches, `⎿` results, edit previews | `/compact-tools claude` |
| **Codex** | `• Explored` groups, `• Ran` output, highlighted diffs | `/compact-tools codex` |
| **Compact** (default) | One row per call: status, duration, line count, and diff | `/compact-tools compact` |

Switching redraws existing rows, even while tools run. Only read-only exploration is grouped; commands that write or execute work keep separate rows.

### Claude

![Claude: grouped exploration, tests, writes, edits, and expanded output](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/claude-style.gif)

### Codex

![Codex: Explored groups, Ran output, Wrote and Edited rows](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/codex-style.gif)

### Compact

![Compact: individual tool rows, completion status, and an edit diff](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/compact-workflow.gif)

## Silent mode

Toggle with **`Ctrl+'`** or `/silent`; use `/silent on` and `/silent off` explicitly. Works with any style. It also hides thinking, intermediate assistant turns, and error/status notices; turn it off to inspect them.

**During work:** hide tool rows while the activity light keeps moving and the answer still arrives. Turn it off to restore every row.

![Silent mode toggled during a running command, then disabled to restore its rows](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/silent-mode.gif)

**In a resumed session:** hide pages of completed tool calls to see the conversation at a glance.

![A resumed session with 18 tool calls reduced to its two prompts and answers](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/silent-history.gif)

This changes the display only—not the saved history or the model's context. Set `"mode": "silent"` to start sessions with it on.

## Codemode summaries

Codemode is Pi's tool for scripts that call other tools. Enable it for a session with `pi --tools +codemode`; use Pi 1.2+ for the native summaries shown here. This extension only renders it.

Completed scripts show outcomes in all three styles: `read 3 · bash 1 · edit 3 2`. Counts use your theme's success, error, and warning colors—green, red, and yellow in the included theme. Each tool appears once; edits come last.

![Codemode outcomes in all three styles: three reads, one command, three successful and two failed edits](https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/assets/nested-calls.gif)

The two failed edits are intentional. Reload/resume preserves summaries from nested-call records; older hosts without those records keep normal previews. See [compatibility details](https://github.com/nedleeds/pi-compact-tools/blob/main/docs/development.md#ui-only-integration-and-compatibility).

## Commands and controls

```text
/compact-tools                 # choose style and save scope
/compact-tools claude project  # save for this trusted project
/compact-tools codex global    # save globally
/compact-tools status          # effective settings and paths
/compact-tools off             # restore Pi's native rows (reloads Pi)
```

Without a scope, changes are saved where the style is configured: project or global. A trusted project's own style overrides a global save. Turning rows off or back on waits for the current response to finish and reloads Pi.

- Click a row/group or press `Ctrl+O` to expand/collapse.
- `Ctrl+T` changes the thinking display, not the model's reasoning effort.
- Choose `github-dark-pro` in Pi's `/settings` for the included theme.

## Configuration

Optional: `~/.pi/agent/compact-tools.json` or `<project>/.pi/compact-tools.json`. Trusted project settings override global settings field by field.

```json
{
  "$schema": "https://raw.githubusercontent.com/nedleeds/pi-compact-tools/main/schemas/compact-tools.schema.json",
  "style": "compact",
  "mode": "normal",
  "previewLines": 10,
  "auto_compact": { "read": true, "write": true, "edit": false, "bash": true },
  "custom_tools": { "enabled": true, "auto_compact": true, "exclude": [] }
}
```

`auto_compact` entries set to `true` start Compact rows collapsed. Add tool names to `custom_tools.exclude` to keep their own rendering. All options are described in the linked schema.

## Development

See [development, compatibility, and demo recording](https://github.com/nedleeds/pi-compact-tools/blob/main/docs/development.md). Run `npm ci` and `npm run check` before contributing.

## License

MIT
