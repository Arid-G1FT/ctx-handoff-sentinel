# Install the ctx-guard Agent Skill for Claude Code and/or Codex.
#
#   pwsh -File install.ps1              # both, when both homes exist
#   pwsh -File install.ps1 -Claude      # ~/.claude/skills/ctx-guard
#   pwsh -File install.ps1 -Codex       # ~/.codex/skills/ctx-guard
#   pwsh -File install.ps1 -Force       # overwrite an existing install
#
# Overrides (useful for tests and non-standard homes):
#   CLAUDE_SKILLS_DIR, CODEX_HOME
param(
    [switch]$Claude,
    [switch]$Codex,
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$skillDir = Join-Path $root "skill"
if (-not (Test-Path (Join-Path $skillDir "SKILL.md"))) {
    throw "ctx-guard: skill/SKILL.md not found next to this script ($root)"
}

if (-not $Claude -and -not $Codex) {
    $Claude = $true
    $Codex = $true
}

$claudeRoot = if ($env:CLAUDE_SKILLS_DIR) { $env:CLAUDE_SKILLS_DIR } else { Join-Path $HOME ".claude\skills" }
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
$codexRoot = Join-Path $codexHome "skills"

function Install-Skill {
    param([string]$Label, [string]$Root)
    $dest = Join-Path $Root "ctx-guard"
    if ((Test-Path $dest) -and (-not $Force)) {
        Write-Error "ctx-guard: $Label already exists at $dest (use -Force to overwrite)"
        return $false
    }
    New-Item -ItemType Directory -Force -Path $Root | Out-Null
    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Copy-Item -Path (Join-Path $skillDir "*") -Destination $dest -Recurse -Force
    # Never ship local test caches.
    Get-ChildItem -Path $dest -Recurse -Force -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Path $dest -Recurse -Force -File -Include "*.pyc" -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue
    Write-Host "ctx-guard: installed $Label -> $dest"
    return $true
}

$ok = $true
if ($Claude) { $ok = (Install-Skill -Label "Claude Code" -Root $claudeRoot) -and $ok }
if ($Codex) { $ok = (Install-Skill -Label "Codex" -Root $codexRoot) -and $ok }

if ($ok) {
    Write-Host ""
    Write-Host 'Next: run /ctx-guard in a session, or ask "should I start a new conversation?".'
}
if (-not $ok) { exit 1 }
