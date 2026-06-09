!include "FileFunc.nsh"

!if "$%WESIGHT_ENABLE_DEFENDER_EXCLUSION%" == "1"
  !define WESIGHT_ENABLE_DEFENDER_EXCLUSION
!endif

!macro customHeader
  !ifdef WESIGHT_ENABLE_DEFENDER_EXCLUSION
    ; Defender exclusion changes require elevation. Builds without the
    ; WESIGHT_ENABLE_DEFENDER_EXCLUSION=1 opt-in keep the normal asInvoker flow.
    RequestExecutionLevel admin
  !endif

  ; Keep the assisted installer focused on the normal progress bar. The
  ; resource extraction is tracked in install-timing.log for diagnostics.
  ShowInstDetails nevershow
  ShowUninstDetails show
!macroend

!macro customInit
  ; ── Kill every process that might hold file handles in the install dir ──
  ;
  ; 1. WeSight.exe — the main app AND the OpenClaw gateway (ELECTRON_RUN_AS_NODE)
  ; 2. node.exe whose binary lives inside the WeSight install tree
  ;    (Web Search bridge server, MCP servers spawned with detached:true)
  ;
  ; Stop-Process -Force is equivalent to taskkill /F — the processes have no
  ; chance to run before-quit cleanup, so file handles may linger briefly as
  ; "ghost handles" in the Windows kernel. We poll until no matching process
  ; remains. The install directory is removed later, after assisted installer
  ; directory selection has finalized $INSTDIR.

  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -Command "\
    Stop-Process -Name WeSight -Force -ErrorAction SilentlyContinue;\
    Get-Process node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like \"*WeSight*\" } | Stop-Process -Force -ErrorAction SilentlyContinue;\
    for ($$i = 0; $$i -lt 15; $$i++) {\
      $$procs = @();\
      $$procs += Get-Process -Name WeSight -ErrorAction SilentlyContinue;\
      $$procs += Get-Process node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like \"*WeSight*\" };\
      if ($$procs.Count -eq 0) { break };\
      Start-Sleep -Milliseconds 500;\
    }"'
  Pop $0
!macroend

!macro customCheckAppRunning
  ; This macro is invoked from electron-builder's install section after the
  ; assisted installer directory page has finalized $INSTDIR, but before
  ; uninstallOldVersion and installApplicationFiles run. Do final process
  ; cleanup and remove only the selected install directory here.
  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -Command "\
    Stop-Process -Name WeSight -Force -ErrorAction SilentlyContinue;\
    Get-Process node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like \"*WeSight*\" } | Stop-Process -Force -ErrorAction SilentlyContinue;\
    for ($$i = 0; $$i -lt 15; $$i++) {\
      $$procs = @();\
      $$procs += Get-Process -Name WeSight -ErrorAction SilentlyContinue;\
      $$procs += Get-Process node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like \"*WeSight*\" };\
      if ($$procs.Count -eq 0) { break };\
      Start-Sleep -Milliseconds 500;\
    }"'
  Pop $0

  ; After all processes are gone, ghost file handles may still linger for a
  ; few seconds. RMDir /r will silently skip locked files but remove the rest
  ; — including the old uninstaller exe. This prevents electron-builder from
  ; invoking old-uninstaller.exe (which lacks our customUnInit and would show
  ; an "app cannot be closed" dialog the user can never dismiss).
  ; The new installer will lay down a complete fresh copy of all files.
  RMDir /r "$INSTDIR"
!macroend

!macro customInstall
  ; ─── Install Timing Log ───
  ; Write timestamps to help diagnose slow installation phases.
  ; Log file: %APPDATA%\WeSight\install-timing.log

  CreateDirectory "$APPDATA\WeSight"
  FileOpen $2 "$APPDATA\WeSight\install-timing.log" w

  ${GetTime} "" "L" $3 $4 $5 $6 $7 $8 $9
  FileWrite $2 "extract-done: $5-$4-$3 $6:$7:$8$\r$\n"

  ; ─── Extract combined resource archive (win-resources.tar) ───
  ; All large resource directories (cfmind/, SKILLs/, python-win/) are packed
  ; into a single tar file. NSIS 7z extracts one large file almost instantly;
  ; we then unpack the tar here using Electron's Node runtime.

  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")i'

  ${GetTime} "" "L" $3 $4 $5 $6 $7 $8 $9
  FileWrite $2 "tar-extract-start: $5-$4-$3 $6:$7:$8$\r$\n"

  nsExec::ExecToStack '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\unpack-cfmind.cjs" "$INSTDIR\resources\win-resources.tar" "$INSTDIR\resources"'
  Pop $0
  Pop $1

  StrCmp $0 "0" TarExtractOK
    FileWrite $2 "tar-extract-error: exit=$0 output=$1$\r$\n"
    MessageBox MB_OK|MB_ICONEXCLAMATION "Resource extraction failed (exit code $0):$\r$\n$\r$\n$1"
  TarExtractOK:

  ${GetTime} "" "L" $3 $4 $5 $6 $7 $8 $9
  FileWrite $2 "tar-extract-done: $5-$4-$3 $6:$7:$8 exit=$0$\r$\n"
  Delete "$INSTDIR\resources\win-resources.tar"

  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "")i'

  ; ─── Windows Defender Exclusion (optional, build-time opt-in) ───
  ; Enable with WESIGHT_ENABLE_DEFENDER_EXCLUSION=1 when producing a trusted
  ; Windows build that should avoid real-time scanning of the bundled runtime.
  ; The command remains best-effort because enterprise policy may disallow it.
  !ifdef WESIGHT_ENABLE_DEFENDER_EXCLUSION
    ; Exclude both the OpenClaw runtime (cfmind/) and the 8 bundled runtimes
    ; (wesight-runtime/) from real-time scanning. Without these exclusions,
    ; Windows Defender quarantines python.exe and its .pyd extensions on
    ; first launch. The exclusions are added before either runtime is unpacked
    ; so the unpacked binaries are never scanned.
    nsExec::ExecToStack 'powershell -NoProfile -NonInteractive -Command "try { Add-MpPreference -ExclusionPath $\"$INSTDIR\resources\cfmind$\" -ErrorAction Stop; Add-MpPreference -ExclusionPath $\"$INSTDIR\resources\wesight-runtime$\" -ErrorAction Stop; Write-Output ok } catch { Write-Output skip }"'
    Pop $0
    Pop $1
    FileWrite $2 "defender-exclusion-add: exit=$0 result=$1$\r$\n"
  !else
    FileWrite $2 "defender-exclusion-add: disabled$\r$\n"
  !endif

  ; Clean up the unpack script — no longer needed after installation
  Delete "$INSTDIR\resources\unpack-cfmind.cjs"

  ${GetTime} "" "L" $3 $4 $5 $6 $7 $8 $9
  FileWrite $2 "install-done: $5-$4-$3 $6:$7:$8$\r$\n"
  FileClose $2
!macroend

!macro customUnInit
  ; Kill all running app instances (main app + OpenClaw gateway + detached
  ; node.exe services) before the uninstaller's built-in process check.
  ; Without this, the uninstaller detects the OpenClaw gateway process
  ; (also named WeSight.exe) and shows an "app cannot be closed" dialog
  ; where even "Retry" never succeeds — because the gateway has no UI window
  ; for the user to close.
  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -Command "\
    Stop-Process -Name WeSight -Force -ErrorAction SilentlyContinue;\
    Get-Process node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like \"*WeSight*\" } | Stop-Process -Force -ErrorAction SilentlyContinue;\
    for ($$i = 0; $$i -lt 15; $$i++) {\
      $$procs = @();\
      $$procs += Get-Process -Name WeSight -ErrorAction SilentlyContinue;\
      $$procs += Get-Process node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like \"*WeSight*\" };\
      if ($$procs.Count -eq 0) { break };\
      Start-Sleep -Milliseconds 500;\
    }"'
  Pop $0
!macroend

!macro customUnInstall
  ; ─── Uninstall Cleanup Log ───
  ; electron-builder removes app data after this macro, so write cleanup
  ; diagnostics to %TEMP% where they survive the uninstall.
  FileOpen $2 "$TEMP\WeSight-uninstall-cleanup.log" w

  ${GetTime} "" "L" $3 $4 $5 $6 $7 $8 $9
  FileWrite $2 "cleanup-start: $5-$4-$3 $6:$7:$8$\r$\n"
  DetailPrint "[1/4] Starting WeSight uninstall cleanup..."

  ; Remove the Defender exclusion if a previous trusted build added it. This
  ; is intentionally best-effort so uninstall still succeeds on locked-down
  ; machines or builds that never enabled the exclusion.
  DetailPrint "[2/4] Removing optional Windows Defender exclusion..."
  nsExec::ExecToStack 'powershell -NoProfile -NonInteractive -Command "try { Remove-MpPreference -ExclusionPath $\"$INSTDIR\resources\cfmind$\" -ErrorAction SilentlyContinue; Write-Output ok } catch { Write-Output skip }"'
  Pop $0
  Pop $1
  FileWrite $2 "defender-exclusion-remove: exit=$0 result=$1$\r$\n"
  DetailPrint "[2/4] Defender cleanup result: $1"

  ; Clear Windows auto-launch leftovers that point to this installation. The
  ; app currently uses Electron login items, but this also handles future Task
  ; Scheduler based builds without touching unrelated tasks.
  DetailPrint "[3/4] Removing auto-launch entries for this installation..."
  nsExec::ExecToStack 'powershell -NoProfile -NonInteractive -Command "\
    try {\
      $$runPath = \"HKCU:\Software\Microsoft\Windows\CurrentVersion\Run\";\
      if (Test-Path $$runPath) {\
        $$props = Get-ItemProperty $$runPath;\
        $$props.PSObject.Properties | Where-Object { $$_.Name -notlike \"PS*\" -and ($$_.Value -like \"*$INSTDIR*\" -or $$_.Value -like \"*WeSight.exe*\") } | ForEach-Object { Remove-ItemProperty -Path $$runPath -Name $$_.Name -ErrorAction SilentlyContinue };\
      }\
      Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { ($$_.TaskName -like \"WeSight*\" -or $$_.TaskName -eq \"ai.wesight.app\") -and (($$_.Actions | Out-String) -like \"*$INSTDIR*\" -or ($$_.Actions | Out-String) -like \"*WeSight.exe*\") } | Unregister-ScheduledTask -Confirm:$$false -ErrorAction SilentlyContinue;\
      Write-Output ok;\
    } catch { Write-Output skip }"'
  Pop $0
  Pop $1
  FileWrite $2 "auto-launch-cleanup: exit=$0 result=$1$\r$\n"
  DetailPrint "[3/4] Auto-launch cleanup result: $1"

  ; Remove leftover installer resource files if an interrupted install left
  ; them behind. The main install directory is removed by electron-builder.
  DetailPrint "[4/4] Removing leftover installer resource files..."
  Delete "$INSTDIR\resources\win-resources.tar"
  Delete "$INSTDIR\resources\unpack-cfmind.cjs"

  ${GetTime} "" "L" $3 $4 $5 $6 $7 $8 $9
  FileWrite $2 "cleanup-done: $5-$4-$3 $6:$7:$8$\r$\n"
  FileClose $2
  DetailPrint "WeSight uninstall cleanup completed."
!macroend
