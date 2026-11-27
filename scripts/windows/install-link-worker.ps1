# =====================================================================
# ISyMCP Link Worker - instalador idempotente para Windows (sin Electron)
# Contrato: ISyMCP Hive + Link + Compute v1 (gist 821f394d, propiedad Windows)
#
# Que hace:
#   1. Regla de firewall SOLO para redes Privadas (Tailscale es red privada):
#      TCP 47831 (link) y UDP 47832 (descubrimiento LAN).
#   2. Tarea programada a nivel usuario, al iniciar sesion, sin ventana de
#      consola (via .vbs generado en %LOCALAPPDATA%\ISyMCP\), que arranca
#      `bun run src/isymcp.ts link serve` desde la raiz de este repo.
#   3. Verifica .wslconfig: si NO existe lo crea con memory=24GB (maquina de
#      32GB); si existe y no coincide, SOLO sugiere - jamas sobrescribe sin
#      que pases -SetWslMemory de forma explicita.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File scripts\windows\install-link-worker.ps1
#   powershell ... -StartNow        # ademas arranca la tarea al terminar
#   powershell ... -SetWslMemory    # aplica memory=24GB a un .wslconfig existente
#   powershell ... -Uninstall       # quita tarea + reglas de firewall
#
# Regla de oro: este script NUNCA toca secretos (identity.json, llaves) y
# NUNCA sobrescribe tu .wslconfig sin el flag explicito -SetWslMemory.
# =====================================================================
param(
  [switch]$StartNow,
  [switch]$SetWslMemory,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$TaskName = "ISyMCP Link Worker"
$RuleTcp  = "ISyMCP Link TCP 47831"
$RuleUdp  = "ISyMCP Link UDP 47832"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Write-Step($msg)  { Write-Host "[link-worker] $msg" }
function Write-Warn2($msg) { Write-Host  "[link-worker] AVISO: $msg" -ForegroundColor Yellow }

if ($Uninstall) {
  Write-Step "Desinstalando tarea y reglas de firewall..."
  foreach ($rule in @($RuleTcp, $RuleUdp)) {
    try { Remove-NetFirewallRule -DisplayName $rule -ErrorAction Stop; Write-Step "  firewall: $rule eliminada" }
    catch { Write-Step "  firewall: $rule no existia" }
  }
  try {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
    Write-Step "  tarea '$TaskName' eliminada"
  } catch { Write-Step "  tarea '$TaskName' no existia" }
  $vbs = Join-Path $env:LOCALAPPDATA "ISyMCP\run-link-worker.vbs"
  if (Test-Path $vbs) { Remove-Item $vbs -Force }
  Write-Step "LISTO (desinstalado). identity.json y peers.json NO fueron tocados."
  exit 0
}

# ---- 0. Requisitos ---------------------------------------------------
$bun = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bun) {
  Write-Warn2 "bun no esta en PATH. Instalalo (https://bun.sh) y vuelve a ejecutar."
  exit 1
}
$entry = Join-Path $RepoRoot "src\isymcp.ts"
if (-not (Test-Path $entry)) {
  Write-Warn2 "No se encontro $entry - ejecuta este script desde scripts\windows\ del repo."
  exit 1
}
Write-Step "Repo: $RepoRoot"
Write-Step "bun : $($bun.Source)"

# ---- 1. Firewall (requiere admin; se omite con aviso si no lo hay) ---
if (Test-Admin) {
  foreach ($spec in @(
    @{ Name = $RuleTcp; Protocol = "TCP"; Port = 47831 },
    @{ Name = $RuleUdp; Protocol = "UDP"; Port = 47832 }
  )) {
    $existing = Get-NetFirewallRule -DisplayName $spec.Name -ErrorAction SilentlyContinue
    if ($existing) {
      Write-Step "Firewall: '$($spec.Name)' ya existe (se deja tal cual)."
    } else {
      # Profile Private: cubre la interfaz de Tailscale sin abrir el puerto a redes publicas.
      New-NetFirewallRule -DisplayName $spec.Name -Direction Inbound `
        -Protocol $spec.Protocol -LocalPort $spec.Port -Profile Private `
        -Action Allow | Out-Null
      Write-Step "Firewall: '$($spec.Name)' creada (Profile=Private, $($spec.Protocol) $($spec.Port))."
    }
  }
} else {
  Write-Warn2 "Sin privilegios de administrador: reglas de firewall OMITIDAS."
  Write-Warn2 "Re-ejecuta en consola elevada para abrir TCP 47831 / UDP 47832 (solo redes privadas)."
}

# ---- 2. Tarea programada (nivel usuario, sin ventana) ----------------
$appDataDir = Join-Path $env:LOCALAPPDATA "ISyMCP"
if (-not (Test-Path $appDataDir)) { New-Item -ItemType Directory -Path $appDataDir | Out-Null }
$vbsPath = Join-Path $appDataDir "run-link-worker.vbs"
$bunExe = $bun.Source.Replace("'", "''")
$repoEsc = $RepoRoot.Replace("'", "''")
$vbsContent = @"
' Generado por install-link-worker.ps1 - arranca el Link Worker sin ventana de consola.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "$repoEsc"
sh.Run """$bunExe"" run src/isymcp.ts link serve", 0, False
"@
# Reescribimos el .vbs SIEMPRE (apunta a bun.exe y repo actuales) - es codigo nuestro, no config del usuario.
Set-Content -Path $vbsPath -Value $vbsContent -Encoding ASCII
Write-Step "Wrapper VBS actualizado: $vbsPath"

$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$action   = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbsPath`"" -WorkingDirectory $RepoRoot
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Trigger $trigger -Action $action `
  -Settings $settings -User $env:USERNAME -RunLevel Limited -Force | Out-Null
Write-Step "Tarea programada '$TaskName' registrada/actualizada (al iniciar sesion, sin consola)."

# ---- 3. .wslconfig (sugerir, no pisar) --------------------------------
$wslConfig = Join-Path $env:USERPROFILE ".wslconfig"
$desiredMemory = "24GB"
if (-not (Test-Path $wslConfig)) {
  Set-Content -Path $wslConfig -Value "[wsl2]`r`nmemory=$desiredMemory`r`n" -Encoding ASCII
  Write-Step ".wslconfig creado (no existia) con memory=$desiredMemory para tu maquina de 32GB."
} else {
  $current = Get-Content $wslConfig -Raw
  if ($current -match "(?m)^\s*memory\s*=\s*(\S+)") {
    if ($Matches[1] -ieq $desiredMemory) {
      Write-Step ".wslconfig ya limita WSL2 a $desiredMemory. OK."
    } else {
      Write-Warn2 ".wslconfig ya define memory=$($Matches[1]) (deseado: $desiredMemory). NO se toco."
      if ($SetWslMemory) {
        (Get-Content $wslConfig) -replace "(?m)^\s*memory\s*=\s*\S+", "memory=$desiredMemory" |
          Set-Content $wslConfig -Encoding ASCII
        Write-Step ".wslconfig actualizado a memory=$desiredMemory (-SetWslMemory explicito)."
      } else {
        Write-Warn2 "Para aplicarlo: re-ejecuta con -SetWslMemory."
      }
    }
  } else {
    Write-Warn2 ".wslconfig existe pero no define memory. Sugerido: memory=$desiredMemory en la seccion [wsl2]. NO se toco."
    if ($SetWslMemory) {
      Add-Content -Path $wslConfig -Value "memory=$desiredMemory" -Encoding ASCII
      Write-Step "memory=$desiredMemory anadida a .wslconfig (-SetWslMemory explicito)."
    } else {
      Write-Warn2 "Para anadirla: re-ejecuta con -SetWslMemory."
    }
  }
}

# ---- 4. Estado final --------------------------------------------------
if ($StartNow) {
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 2
  $state = (Get-ScheduledTask -TaskName $TaskName).State
  Write-Step "Tarea arrancada (-StartNow), estado: $state"
} else {
  Write-Step "Para arrancar ahora:  Start-ScheduledTask -TaskName '$TaskName'"
}
Write-Step "Verificacion rapida:  Get-ScheduledTask -TaskName '$TaskName' | fl State"
Write-Step "Puerto a la escucha:  netstat -ano | findstr 47831"
Write-Step "LISTO."
