; NSIS 自定义安装脚本（electron-builder `nsis.include` 默认落点 = build/installer.nsh）
;
; ─────────────────────────────────────────────────────────────────────────────
; 为什么需要这段：Electron 在 Windows 上的沙箱子进程使用「受限令牌」，
; Windows 会把含 AppContainer package SID（S-1-15-2-*）的 DACL 当作 AppContainer
; 访问检查。若安装目录的 DACL 里没有 ALL APPLICATION PACKAGES（S-1-15-2-1）或
; ALL RESTRICTED APPLICATION PACKAGES（S-1-15-2-2）的读/执行授权，每个沙箱子
; 进程都会被拒绝访问自己的安装目录——最先死的是 GPU 进程，读 icudtl.dat 时
; CHECK 失败触发 base::ImmediateCrash，表现为进程在 JS 执行前就以
; 0x80000003 (STATUS_BREAKPOINT) 退出，无日志无崩溃转储。
;
; 触发条件：安装目录继承了其他软件留下的「孤儿」package ACE，而本身两个
; AppContainer SID 都没有。per-user 安装（%LOCALAPPDATA%\Programs\...）比
; Program Files 更容易踩到——Program Files 默认继承 ALL APPLICATION PACKAGES
; 读权限，这就是 Chrome 装在那里从不遇到此问题的原因。
; 上游追踪：electron/electron#51761 / #49143；维护者给出的规范要求见
; #49143 comment 3618354787（"needs to be done as part of their installers"）。
;
; 关键：**不要**把这段包进 ${ifNot} ${isUpdated}。
; 原地自动更新会重新继承被污染的 DACL 而不重新盖章，导致崩溃在更新后复活。
; 必须在每一条安装/更新路径上都执行。
; ─────────────────────────────────────────────────────────────────────────────

!macro grantSandboxAccess
  DetailPrint "授予沙箱读/执行权限（ALL RESTRICTED APPLICATION PACKAGES）..."
  ; /T 递归、/C 忽略单个文件的错误继续（避免个别文件被占用导致整体失败）
  ; 增量授权：只添加 ACE，不重置/不删除任何既有权限
  nsExec::ExecToLog 'icacls "$INSTDIR" /grant *S-1-15-2-2:(OI)(CI)(RX) /T /C'
  Pop $0
  ${If} $0 != 0
    ; 授权失败不阻断安装：应用仍能启动（Electron 会回退到无沙箱子进程），
    ; 但沙箱保护降级。记入日志供排查。
    DetailPrint "警告：沙箱权限授予返回 $0（安装继续，沙箱可能降级）"
  ${EndIf}
!macroend

!macro customInstall
  !insertmacro grantSandboxAccess
!macroend

; 卸载时不必回收这些 ACE：目录本身会被删除；且删除继承来的 ACE 常不可行。
