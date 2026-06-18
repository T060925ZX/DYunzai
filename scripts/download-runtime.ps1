param(
  [string]$Target = (Join-Path $PSScriptRoot "..\runtime\win-x64")
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$Target = [System.IO.Path]::GetFullPath($Target)
$Temp = Join-Path ([System.IO.Path]::GetTempPath()) ("yunzai-runtime-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $Target, $Temp | Out-Null

function Download($Url, $File) {
  Write-Host "Downloading $Url"
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $File
}

$GitHubHeaders = @{ "User-Agent" = "DYunzai-GitHub-Actions" }
if ($env:GITHUB_TOKEN) {
  $GitHubHeaders["Authorization"] = "Bearer $env:GITHUB_TOKEN"
}

function Reset-Directory($Path) {
  if (Test-Path $Path) { Remove-Item -LiteralPath $Path -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
}

try {
  $nodeVersion = "v24.16.0"
  $nodeZip = Join-Path $Temp "node.zip"
  Download "https://nodejs.org/dist/$nodeVersion/node-$nodeVersion-win-x64.zip" $nodeZip
  $nodeExtract = Join-Path $Temp "node"
  Expand-Archive $nodeZip $nodeExtract
  Reset-Directory (Join-Path $Target "node")
  Copy-Item (Join-Path $nodeExtract "node-$nodeVersion-win-x64\*") (Join-Path $Target "node") -Recurse
  & (Join-Path $Target "node\npm.cmd") install --global --prefix (Join-Path $Target "node") pnpm@11.5.2

  $redisRelease = Invoke-RestMethod -Headers $GitHubHeaders "https://api.github.com/repos/redis-windows/redis-windows/releases/latest"
  $redisAsset = $redisRelease.assets | Where-Object { $_.name -match "Windows-x64-msys2\.zip$" } | Select-Object -First 1
  $redisZip = Join-Path $Temp "redis.zip"
  Download $redisAsset.browser_download_url $redisZip
  $redisExtract = Join-Path $Temp "redis"
  Expand-Archive $redisZip $redisExtract
  Reset-Directory (Join-Path $Target "redis")
  $redisRoot = Get-ChildItem $redisExtract -Directory | Select-Object -First 1
  Copy-Item (Join-Path $redisRoot.FullName "*") (Join-Path $Target "redis") -Recurse

  $ffmpegRelease = Invoke-RestMethod -Headers $GitHubHeaders "https://api.github.com/repos/GyanD/codexffmpeg/releases/latest"
  $ffmpegAsset = $ffmpegRelease.assets | Where-Object { $_.name -match "essentials_build\.zip$" } | Select-Object -First 1
  $ffmpegZip = Join-Path $Temp "ffmpeg.zip"
  Download $ffmpegAsset.browser_download_url $ffmpegZip
  $ffmpegExtract = Join-Path $Temp "ffmpeg"
  Expand-Archive $ffmpegZip $ffmpegExtract
  Reset-Directory (Join-Path $Target "ffmpeg")
  $ffmpegRoot = Get-ChildItem $ffmpegExtract -Directory | Select-Object -First 1
  Copy-Item (Join-Path $ffmpegRoot.FullName "*") (Join-Path $Target "ffmpeg") -Recurse
  Remove-Item (Join-Path $Target "ffmpeg\bin\ffplay.exe") -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $Target "ffmpeg\doc") -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $Target "ffmpeg\presets") -Recurse -Force -ErrorAction SilentlyContinue

  $gitRelease = Invoke-RestMethod -Headers $GitHubHeaders "https://api.github.com/repos/git-for-windows/git/releases/latest"
  $gitAsset = $gitRelease.assets | Where-Object { $_.name -match "^MinGit-.*-64-bit\.zip$" } | Select-Object -First 1
  $gitArchive = Join-Path $Temp "MinGit.zip"
  Download $gitAsset.browser_download_url $gitArchive
  Reset-Directory (Join-Path $Target "git")
  Expand-Archive $gitArchive (Join-Path $Target "git")

  $manifest = @{
    generatedAt = (Get-Date).ToString("o")
    node = $nodeVersion
    pnpm = "11.5.2"
    redis = $redisRelease.tag_name
    ffmpeg = $ffmpegRelease.tag_name
    git = $gitRelease.tag_name
  } | ConvertTo-Json
  Set-Content -LiteralPath (Join-Path $Target "manifest.json") -Value $manifest -Encoding UTF8
  Write-Host "Runtime ready at $Target"
} finally {
  if (Test-Path $Temp) { Remove-Item -LiteralPath $Temp -Recurse -Force }
}
