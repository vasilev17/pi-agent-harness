# Pi agent setup

My [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) configuration: settings, extensions, two patched packages, and a small editor extension. This repo is Pi's agent directory itself, so a clone is a working setup.

Built and used on Windows 10 with Windows Terminal. Most of it is platform-neutral. The startup image, the Nerd Font glyphs, and the background painting assume a modern terminal.

## Layout

| Path | What |
| --- | --- |
| `settings.json` | Default provider/model (Cursor ACP, `grok-4.7`), thinking levels, package list. |
| `keybindings.json` | Shift+Up/Down walk prompt history. |
| `compact-tools.json` | Options for `pi-compact-tools`. |
| `awesome-pi-themes-look-pack.json` | Turns off the look pack that ships with `awesome-pi-themes`. |
| `cursor-acp-provider/config.json` | Cursor ACP defaults: full access, agent mode, fast, 256k context. |
| `extensions/` | Local extensions. Each file starts with a comment saying what it does and why. |
| `packages/pi-cursor-acp-provider/` | Patched fork of `pi-cursor-acp-provider`. |
| `packages/pi-compact-tools/` | Patched fork of `pi-compact-tools`. |
| `editor/pi-editor-open/` | VS Code/Cursor extension that opens a file at a line span when Pi asks. |
| `scripts/install.ps1` | Sets up a new machine. |
| `scripts/smoke-test.mjs` | Loads Pi in RPC mode and lists commands; no model call. |

Everything else Pi writes here (sessions, `auth.json`, caches, downloaded `fd`/`rg`, npm installs) is ignored by `.gitignore`.

## Vendored packages

Both are MIT licensed; their `LICENSE` files are kept. They live in the repo instead of being installed from npm so that `pi update` cannot overwrite the patches.

**`pi-cursor-acp-provider`** (from [zacbemis/pi-cursor-acp-provider](https://github.com/zacbemis/pi-cursor-acp-provider) 0.1.4)

- Tools Cursor runs itself show up in the transcript as a display-only `Cursor` tool with diffs, instead of disappearing.
- `/fast`, `/mode`, `/agent`, `/ask`, `/plan`, `/context` set Cursor options per session.
- Esc ends the Cursor session; canceled turns are left out when the next prompt rebuilds context.
- Config and caches follow `PI_CODING_AGENT_DIR`.

**`pi-compact-tools`** (from [nedleeds/pi-compact-tools](https://github.com/nedleeds/pi-compact-tools) 0.16.2)

- `/silent` levels: on, off, edits only, edits only with thinking. New sessions start at edits only.
- Nerd Font glyphs on the idle editor border and the working label.
- Colors and file-change counts for `Cursor` tool rows.
- The activity line under the prompt is off.

`awesome-pi-themes` is still installed from npm. `settings.json` filters out its `codex-slate` theme.

## Install on a new machine

Requirements: Node 22.19 or newer, git, a [Nerd Font](https://www.nerdfonts.com/) set in the terminal, and the [Cursor Agent CLI](https://cursor.com/docs/cli/installation). The footer's usage meter reads the Cursor login from `%APPDATA%\Cursor` or `~/.cursor`.

Pi reads `~/.pi/agent` and ignores every other folder unless `PI_CODING_AGENT_DIR` points at it. Clone this repo anywhere. `scripts/install.ps1` junctions `~/.pi/agent` to the clone, so Pi's default path still works and the project can live next to other repos. Do not set `PI_CODING_AGENT_DIR` once that junction exists. If it is set to a different path, Pi loads that path instead of this clone.

```powershell
git clone https://github.com/vasilev17/pi-agent-harness.git pi-agent-harness
powershell -ExecutionPolicy Bypass -File .\pi-agent-harness\scripts\install.ps1
cursor-agent login
```

Cloning straight into `~/.pi/agent` also works. The script sees that and skips the junction.

The script:

1. Junctions `~/.pi/agent` to this clone when the clone is somewhere else. If `~/.pi/agent` already exists and is a different directory, the script stops. It does not delete that directory.
2. Installs Pi 1.3.0 globally. The patches touch Pi internals, so upgrade Pi deliberately and re-run the smoke test.
3. Runs `npm ci` for the provider's runtime dependencies. Pi's own packages are peers that Pi supplies at load time. A copy in `node_modules` would create duplicate classes, so they are left out.
4. Builds `editor/pi-editor-open` into a `.vsix` and installs it into `cursor` and `code` if they are on `PATH`.
5. Installs the skills listed below into `~/.agents/skills`. Pi loads that directory itself.
6. Runs the smoke test. `"ok": true` with an empty `stderr` means every extension loaded.

Flags: `-SkipPi`, `-SkipEditor`, `-SkipEditorInstall`, `-SkipSkills`.

`cursor-agent login` is a credential on that machine. It is not in the repo. The script cannot do it.

After install, quit any Pi process that was already running and start `pi` again. A running process keeps the code it loaded at startup.

## Skills

Pi loads skills from `~/.pi/agent/skills` and from `~/.agents/skills`. This repo has no `skills/` directory. The skills on the original machine are upstream packages shared with other agents, so they are installed by the script instead of copied here:

| Source | Skills |
| --- | --- |
| `JuliusBrussee/caveman` | `cavecrew`, `caveman`, `caveman-commit`, `caveman-compress`, `caveman-help`, `caveman-review`, `caveman-stats` |
| `vercel-labs/skills` | `find-skills` |
| `latent-spaces/brag` | `brag` |
| `heygen-com/hyperframes` | `hyperframes`, `hyperframes-animation`, `hyperframes-audio`, `hyperframes-cli`, `hyperframes-core`, `hyperframes-creative`, `hyperframes-keyframes`, `hyperframes-registry`, `hyperframes-studio`, `media-use` |

## Not in this repo

Pi writes these into the agent directory. `.gitignore` ignores everything that is not the setup, so a clone does not contain them:

- `auth.json` and Cursor login tokens
- `sessions/`
- `cursor-acp-provider/models.json` and `sessions.json` (caches; `config.json` is the setup and is tracked)
- `node_modules/`, `npm/`, and the `fd` / `rg` binaries Pi downloads into `bin/`
- editor build output (`out/`, `*.vsix`)

`awesome-pi-themes` is not vendored. Pi installs it from npm because `settings.json` lists it. The theme filter in that file is what drops `codex-slate`.
