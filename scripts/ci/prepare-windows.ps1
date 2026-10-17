$ErrorActionPreference = 'Stop'
$git = Get-Command git.exe -ErrorAction Stop
$gitRoot = Split-Path -Parent (Split-Path -Parent $git.Source)
$bash = Join-Path $gitRoot 'bin/bash.exe'
if (-not (Test-Path -LiteralPath $bash)) { throw 'Git Bash não encontrado na instalação do Git for Windows.' }
[IO.File]::AppendAllText($env:GITHUB_PATH, (Split-Path -Parent $bash) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
$docker = Get-Command docker.exe -ErrorAction SilentlyContinue
if (-not $docker) { throw 'Docker CLI ausente no PATH do processo do runner. Configure o PATH da conta que executa o runner e reinicie o processo/serviço.' }
[IO.File]::AppendAllText($env:GITHUB_PATH, (Split-Path -Parent $docker.Source) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
Write-Host "Docker CLI localizado pelo PATH: $($docker.Source)"
