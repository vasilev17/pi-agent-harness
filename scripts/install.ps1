<#
.SYNOPSIS
  Sets up this Pi configuration on a machine. Run from anywhere; safe to re-run.

.DESCRIPTION
  1. Installs the Pi CLI version the vendored packages were patched against.
  2. Installs runtime dependencies of the vendored Cursor ACP provider.
  3. Builds the pi-editor-open VS Code/Cursor extension and installs it into
     every editor CLI found on PATH (cursor, code).
  4. Runs the smoke test.

  The repo must be Pi's agent directory: clone it to ~/.pi/agent, or clone it
  anywhere and set PI_CODING_AGENT_DIR to that path.
#>
param(
	[switch]$SkipPi,
	[switch]$SkipEditor,
	[switch]$SkipEditorInstall
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$piVersion = "1.3.0"

function Invoke-Step([string]$label, [scriptblock]$body) {
	Write-Host "==> $label" -ForegroundColor Cyan
	& $body
	if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "$label failed (exit $LASTEXITCODE)" }
}

$expected = [IO.Path]::GetFullPath($(if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $HOME ".pi\agent" })).TrimEnd('\')
if ($expected -ne $root.TrimEnd('\')) {
	Write-Warning "Pi reads $expected, but this repo is $root. Clone it there, or set PI_CODING_AGENT_DIR=$root."
}

$nodeVersion = [version]((node -v).TrimStart("v"))
if ($nodeVersion -lt [version]"22.19.0") { throw "Node $nodeVersion found; pi-compact-tools needs >= 22.19.0." }

if (-not $SkipPi) {
	Invoke-Step "Pi CLI $piVersion" { npm install -g "@earendil-works/pi-coding-agent@$piVersion" }
}

# Peers (pi-ai, pi-coding-agent, typebox) are supplied by Pi at runtime. A copy on disk
# would bypass Pi's module mapping and create duplicate classes, so peers stay out.
Invoke-Step "Cursor ACP provider dependencies" {
	Push-Location (Join-Path $root "packages\pi-cursor-acp-provider")
	try { npm ci --omit=dev --legacy-peer-deps --no-audit --no-fund --ignore-scripts } finally { Pop-Location }
}

if (-not $SkipEditor) {
	$editor = Join-Path $root "editor\pi-editor-open"
	Invoke-Step "Build pi-editor-open" {
		Push-Location $editor
		try {
			npm ci --no-audit --no-fund
			if ($LASTEXITCODE -ne 0) { return }
			npm run compile
			if ($LASTEXITCODE -ne 0) { return }
			npx --yes @vscode/vsce package --allow-missing-repository --skip-license -o out/pi-editor-open.vsix
		} finally { Pop-Location }
	}
	if (-not $SkipEditorInstall) {
		$vsix = Join-Path $editor "out\pi-editor-open.vsix"
		foreach ($cli in "cursor", "code") {
			if (Get-Command $cli -ErrorAction SilentlyContinue) {
				Invoke-Step "Install pi-editor-open into $cli" { & $cli --install-extension $vsix --force }
			}
		}
	}
}

if (-not (Get-Command cursor-agent -ErrorAction SilentlyContinue) -and -not (Get-Command agent -ErrorAction SilentlyContinue)) {
	Write-Warning "Cursor Agent CLI not found. Install it (https://cursor.com/docs/cli/installation), then run: cursor-agent login"
}

Invoke-Step "Smoke test" { node (Join-Path $PSScriptRoot "smoke-test.mjs") }
