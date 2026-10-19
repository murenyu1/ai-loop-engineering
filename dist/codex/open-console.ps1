$ErrorActionPreference = 'Stop'
$entry = Join-Path $PSScriptRoot 'scripts/console.mjs'
if (-not (Test-Path -LiteralPath $entry)) { throw '缺少管理面板程序，请重新下载完整 Codex 插件包。' }
$runtime = (Get-Command node -ErrorAction Stop).Source
Start-Process -FilePath $runtime -ArgumentList @(('"' + $entry + '"')) -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
