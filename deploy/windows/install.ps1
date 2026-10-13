# Sets up jobhunter on Windows 11 with Ollama. Run from the project folder in PowerShell:
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1 [-RunAt 00:30] [-SkipModel]
param(
  [string]$RunAt = "00:30",
  [string]$JobProfile = "nuc-ollama",
  [switch]$SkipModel
)
$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Write-Host "jobhunter at $Root"

# 1. Tools
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "Node.js not found. Install Node 24 LTS: winget install OpenJS.NodeJS.LTS" }
if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) { throw "Ollama not found. Install it: winget install Ollama.Ollama" }
if (-not (Get-Command pi -ErrorAction SilentlyContinue)) {
  Write-Host "Installing pi..."
  npm install -g @earendil-works/pi-coding-agent
}
if (-not (Get-Command pandoc -ErrorAction SilentlyContinue)) { Write-Warning "pandoc not found (needed for cv.docx): winget install JohnMacFarlane.Pandoc" }

# 2. Dependencies
Push-Location $Root
npm install
Pop-Location

# 3. pi model config
$agent = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $env:USERPROFILE ".pi\agent" }
New-Item -ItemType Directory -Force -Path $agent | Out-Null
$models = Join-Path $agent "models.json"
if (Test-Path $models) {
  Write-Warning "$models already exists; merge the 'ollama' provider from deploy\pi-models\ollama.json into it by hand."
} else {
  Copy-Item (Join-Path $Root "deploy\pi-models\ollama.json") $models
  Write-Host "Wrote $models"
}
pi install $Root

# 4. Model with a 16k context (~19 GB download)
if (-not $SkipModel) {
  ollama pull qwen3:30b-a3b-instruct-2507-q4_K_M
  ollama create jobhunter-qwen -f (Join-Path $PSScriptRoot "Modelfile")
}

# 5. Nightly task. It runs as you, while you're signed in (Ollama's tray app runs per user).
#    WakeToRun wakes the NUC from sleep if "Allow wake timers" is enabled in the power plan.
$action = New-ScheduledTaskAction -Execute $node -Argument "src\nightly.ts --profile=$JobProfile" -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -Daily -At $RunAt
$settings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 8)
Register-ScheduledTask -TaskName "jobhunter-nightly" -Action $action -Trigger $trigger -Settings $settings -Description "jobhunter: fetch, score, tailor, report" -Force | Out-Null
Write-Host "Scheduled 'jobhunter-nightly' daily at $RunAt."

Write-Host "`nNext: npm run doctor -- --context    (checks pi, Ollama, tool calls and the 16k context)"
Write-Host "Then: put your CV in data\ and run  pi  then  /jh-setup"
