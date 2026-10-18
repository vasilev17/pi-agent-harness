<#
.SYNOPSIS
  Sets up this Pi configuration on a machine. Run from anywhere; safe to re-run.

.DESCRIPTION
  1. Junctions ~/.pi/agent at this repo when the clone lives somewhere else.
     Pi reads ~/.pi/agent unless PI_CODING_AGENT_DIR is set. A junction keeps
     the default path working, so the clone can sit with other projects.
  2. Installs the Pi CLI version the vendored packages were patched against.
  3. Installs runtime dependencies of the vendored Cursor ACP provider.
  4. Builds the pi-editor-open VS Code/Cursor extension and installs it into
     every editor CLI found on PATH (cursor, code).
  5. Runs the smoke test.
#>
param(
	[switch]$SkipPi,
	[switch]$SkipEditor,
	[switch]$SkipEditorInstall
)

$ErrorActionPreference = "Stop"
$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\')
$piVersion = "1.3.0"

function Invoke-Step([string]$label, [scriptblock]$body) {
	Write-Host "==> $label" -ForegroundColor Cyan
	& $body
	if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "$label failed (exit $LASTEXITCODE)" }
}

function Same-Path([string]$a, [string]$b) {
	if (-not $a -or -not $b) { return $false }
	return $a.TrimEnd('\').Equals($b.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
}

# PS 5.1 has no DirectoryInfo.Target. `dir /AL` prints: <JUNCTION> name [target]
function Get-FinalPath([string]$path) {
	$item = Get-Item -LiteralPath $path -Force
	$full = [IO.Path]::GetFullPath($item.FullName).TrimEnd('\')
	if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $full }
	$parent = Split-Path -Parent $item.FullName
	$name = Split-Path -Leaf $item.FullName
	$listing = cmd /c "dir /AL `"$parent`""
	$pattern = '<(JUNCTION|SYMLINKD)>\s+' + [regex]::Escape($name) + '\s+\[(.+)\]'
	foreach ($line in @($listing)) {
		if ($line -match $pattern) { return [IO.Path]::GetFullPath($Matches[2]).TrimEnd('\') }
	}
	throw "Could not read junction target of $full"
}

function Ensure-AgentLink([string]$repo) {
	$agent = [IO.Path]::GetFullPath((Join-Path $HOME ".pi\agent")).TrimEnd('\')
	if (Same-Path $agent $repo) {
		Write-Host "Repo is already $agent"
		return
	}
	if (Test-Path -LiteralPath $agent) {
		$final = Get-FinalPath $agent
		if (Same-Path $final $repo) {
			Write-Host "$agent already points at this repo"
			return
		}
		throw "$agent exists and is not this repo ($final). Move that directory aside, then re-run. This script will not delete it."
	}
	$parent = Split-Path -Parent $agent
	if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
	if ($env:OS -eq "Windows_NT") {
		Invoke-Step "Junction $agent -> $repo" { cmd /c "mklink /J `"$agent`" `"$repo`"" }
	} else {
		Invoke-Step "Symlink $agent -> $repo" { New-Item -ItemType SymbolicLink -Path $agent -Target $repo | Out-Null }
	}
}

Ensure-AgentLink $root

if ($env:PI_CODING_AGENT_DIR) {
	$override = [IO.Path]::GetFullPath($env:PI_CODING_AGENT_DIR).TrimEnd('\')
	if (-not (Same-Path $override $root)) {
		Write-Warning "PI_CODING_AGENT_DIR=$override overrides ~/.pi/agent. Unset it, or point it at $root, or Pi will not load this clone."
	}
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
