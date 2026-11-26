; Up to 0.4.203 the app was installed as "Skipi Seafarer"; from the next release it is "Skipi".
; The NSIS installer keys an install by product name, so an update would put "Skipi" next to the
; old "Skipi Seafarer" copy and leave its shortcuts behind. Remove that old copy silently.
; A silent uninstall keeps app data (only the "delete app data" checkbox removes it), and the
; data folder follows the identifier app.skipi.desktop, which both names share.
!macro NSIS_HOOK_POSTINSTALL
  ReadRegStr $R0 SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\Skipi Seafarer" "InstallLocation"
  StrCmp $R0 "" skipi_old_name_done
  StrCpy $R1 $R0 1
  StrCmp $R1 '"' 0 +3
    StrCpy $R0 $R0 "" 1
    StrCpy $R0 $R0 -1
  StrCmp $R0 $INSTDIR skipi_old_name_done
  IfFileExists "$R0\uninstall.exe" 0 skipi_old_name_done
  ExecWait '"$R0\uninstall.exe" /S _?=$R0'
  Delete "$R0\uninstall.exe"
  RMDir "$R0"
  skipi_old_name_done:
!macroend
