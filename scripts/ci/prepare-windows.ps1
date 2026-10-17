$ErrorActionPreference = 'Stop'
$git = Get-Command git.exe -ErrorAction Stop
$gitRoot = Split-Path -Parent (Split-Path -Parent $git.Source)
$bash = Join-Path $gitRoot 'bin/bash.exe'
if (-not (Test-Path -LiteralPath $bash)) { throw 'Git Bash não encontrado na instalação do Git for Windows.' }
[IO.File]::AppendAllText($env:GITHUB_PATH, (Split-Path -Parent $bash) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
$docker = Get-Command docker.exe -ErrorAction SilentlyContinue
if (-not $docker) {
  $searchPaths = @(
    ([Environment]::GetEnvironmentVariable('Path', 'Machine') -split ';')
    ([Environment]::GetEnvironmentVariable('Path', 'User') -split ';')
    (Join-Path $env:ProgramFiles 'Docker/Docker/resources/bin')
  )
  foreach ($directory in $searchPaths) {
    if ([string]::IsNullOrWhiteSpace($directory)) { continue }
    $candidate = Join-Path ([Environment]::ExpandEnvironmentVariables($directory.Trim('"'))) 'docker.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      $docker = Get-Item -LiteralPath $candidate
      break
    }
  }
}
if (-not $docker) { throw 'Docker CLI não localizado para a conta do runner. Confira a instalação e reinicie o processo/serviço do runner após alterar o PATH.' }
$dockerPath = if ($docker -is [System.Management.Automation.CommandInfo]) { $docker.Source } else { $docker.FullName }
[IO.File]::AppendAllText($env:GITHUB_PATH, (Split-Path -Parent $dockerPath) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
Write-Host "Docker CLI localizado: $dockerPath"
