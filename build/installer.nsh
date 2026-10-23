; NSIS 自定义安装脚本（electron-builder `nsis.include` 默认落点 = build/installer.nsh）
;
; 时序很重要：本文件被 !include 在生成脚本的**最前面**（早于 electron-builder 的模板），
; 所以顶层 !define 先于模板生效，而宏（customHeader / customInstall / customUnInit /
; customUnInstall）由模板在各自位置 !insertmacro。

!include LogicLib.nsh

; ─────────────────────────────────────────────────────────────────────────────
; 一、安装体验：可选安装目录 + 看得见的安装日志
;    （业主 2026-10-21：「安装的时候不能选择安装位置 / 不能显示安装日志」；
;      同日二次定调：安装日志只显示在进度条**上方**的细节列表里，进度条**下方**
;      什么都不显示（品牌文字也算），完成页不要「查看安装日志」勾选框。）
;
; 目录页不需要脚本：package.json 的 `nsis.allowToChangeInstallationDirectory` 打开即出
; 目录页；选完目录后模板会在末尾补上 APP_FILENAME（用户选 D:\Apps 实际落到
; D:\Apps\MediaGet），这一步是模板的 instFilesPre。
;
; 细节面板必须在脚本里补，因为模板把两处都关死了：
;   · common.nsh 顶层 `ShowInstDetails nevershow`——连「显示详细信息」按钮都不给；
;   · installSection.nsh 在复制文件前 `SetDetailsPrint none`——逐文件的 Extract 行被丢弃。
; 前者用 customHeader 重开（该宏插在 common.nsh 之后、仍是全局作用域，同名属性的
; 后写者胜，属编译期覆盖）；后者在本文件这一层改不掉——上游 issue 里唯一的办法是
; beforePack 钩子把 node_modules 的 installSection.nsh 换掉（monkey patch，升级即失效），
; 本仓不走这条路。空白段改由 customHeader 里的**隐藏区段**补：区段名以 `-` 开头
; （组件页看不见但照样执行），且声明在模板的 `Section "install"` 之前，于是它先跑，
; 那一行状态就能在整个「载荷解包 + 复制进安装目录」期间留在面板上。
; 阶段摘要仍由 customInstall 自己产出：只进进度条上方的细节列表（SetDetailsPrint
; listonly，下方的状态行与品牌文字都不写），完整一份落 $INSTDIR\install.log，
; 完成页不放按钮，要排查时手动打开该文件。
; ─────────────────────────────────────────────────────────────────────────────

; 三个变量只在安装趟的 customInstall 里用；卸载器趟若声明而不引用会触发 6001，
; 而 electron-builder 以 /WX 调 makensis（警告即编译失败）。
!ifndef BUILD_UNINSTALLER
  Var /GLOBAL sandboxAclResult
  Var /GLOBAL installLogHandle
  Var /GLOBAL installScopeLabel
!endif

!macro customHeader
  ; 进度条下方留白：品牌文字也置空（common.nsh 把它设成了 "${PRODUCT_NAME} ${VERSION}"，
  ; 同名属性后写者胜；用单个空格而不是 ""，旧版 makensis 对空串会回落默认值）
  BrandingText " "
  !ifdef BUILD_UNINSTALLER
    ShowUninstDetails show
  !else
    ShowInstDetails show

    ; 隐藏区段：区段名以 `-` 开头 → 组件页看不见，但照样按声明顺序执行。customHeader 被
    ; 插在模板的 `Section "install"` 之前，所以这一段先跑，打印的那一行能在整个「载荷解包
    ; + 复制进安装目录」期间留在细节面板上（主安装段一进门就 SetDetailsPrint none，之后
    ; 模板不再放行任何文字）。listonly 而不是 both：下方状态行按业主定调保持留白。
    Section "-install status"
      ${IfNot} ${Silent}
        SetDetailsPrint listonly
        DetailPrint "正在解压应用文件到 $INSTDIR，这一步需要一些时间，请稍候……"
      ${EndIf}
    SectionEnd
  !endif
!macroend

; ─────────────────────────────────────────────────────────────────────────────
; 二、沙箱读/执行权限（保持原样，别删）
;
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
;
; icacls /T 会为每个文件打一行，灌进细节面板就是几百行噪声，所以这段保持静默
; （模板在本段之前已经 SetDetailsPrint none），只把退出码带进摘要与日志。
; ─────────────────────────────────────────────────────────────────────────────

!macro grantSandboxAccess
  DetailPrint "授予沙箱读/执行权限（ALL RESTRICTED APPLICATION PACKAGES）..."
  ; /T 递归、/C 忽略单个文件的错误继续（避免个别文件被占用导致整体失败）
  ; 增量授权：只添加 ACE，不重置/不删除任何既有权限
  nsExec::ExecToLog 'icacls "$INSTDIR" /grant *S-1-15-2-2:(OI)(CI)(RX) /T /C'
  Pop $sandboxAclResult
  ${If} $sandboxAclResult != 0
    ; 授权失败不阻断安装：应用仍能启动（Electron 会回退到无沙箱子进程），
    ; 但沙箱保护降级。记入日志供排查。
    DetailPrint "警告：沙箱权限授予返回 $sandboxAclResult（安装继续，沙箱可能降级）"
  ${EndIf}
!macroend

; 卸载时不必回收这些 ACE：目录本身会被删除；且删除继承来的 ACE 常不可行。

; ─────────────────────────────────────────────────────────────────────────────
; 三、安装收尾：写日志 + 把阶段摘要放上细节面板
; ─────────────────────────────────────────────────────────────────────────────

!macro customInstall
  !insertmacro grantSandboxAccess

  ${If} $installMode == "all"
    StrCpy $installScopeLabel "所有用户（本机共用）"
  ${Else}
    StrCpy $installScopeLabel "仅当前用户"
  ${EndIf}

  ; UTF-16LE + BOM：否则记事本会把中文读成乱码
  FileOpen $installLogHandle "$INSTDIR\install.log" w
  ${IfNot} ${Errors}
    FileWriteUTF16LE /BOM $installLogHandle "MediaGet ${VERSION} 安装日志$\r$\n"
    FileWriteUTF16LE $installLogHandle "安装目录：$INSTDIR$\r$\n"
    FileWriteUTF16LE $installLogHandle "安装范围：$installScopeLabel$\r$\n"
    FileWriteUTF16LE $installLogHandle "沙箱读/执行权限（icacls）：返回 $sandboxAclResult（0 = 成功）$\r$\n"
    FileWriteUTF16LE $installLogHandle "安装结果：成功$\r$\n"
    FileWriteUTF16LE $installLogHandle "应用运行日志：设置页「打开日志目录」$\r$\n"
    FileWriteUTF16LE $installLogHandle "说明：本文件随卸载一并删除；逐文件复制行由 electron-builder 模板关闭，此处只有阶段摘要。$\r$\n"
    FileClose $installLogHandle
  ${EndIf}

  ${IfNot} ${Silent}
    ; listonly：只写进度条上方的细节列表；下方状态行保持留白（业主 2026-10-21 二次定调）
    SetDetailsPrint listonly
    DetailPrint "安装目录：$INSTDIR"
    DetailPrint "安装范围：$installScopeLabel"
    DetailPrint "沙箱读/执行权限：icacls 返回 $sandboxAclResult（0 = 成功）"
    DetailPrint "安装完成：${PRODUCT_NAME} ${VERSION}"
  ${EndIf}
!macroend

; ─────────────────────────────────────────────────────────────────────────────
; 四、卸载：看得见进度 + 数据去留交给用户
;
; 只改非静默路径：升级时模板用 `/S /KEEP_APP_DATA` 跑旧卸载器
; （include/installUtil.nsh 的 uninstallOldVersion），那里绝不能弹框，
; 否则自动更新会卡在一个没人看见的确认框上。
; ─────────────────────────────────────────────────────────────────────────────

!ifdef BUILD_UNINSTALLER
  !macro customUnInstall
    ${IfNot} ${Silent}
      SetDetailsPrint both
      DetailPrint "正在卸载 ${PRODUCT_NAME}：$INSTDIR"

      ; 默认按钮 = 否（保留数据）：误点一次不该把用户的历史清空
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "卸载时是否同时删除本地数据？$\r$\n$\r$\n包含设置、Cookie、解析历史、统计与未完成的下载队列。$\r$\n选「否」将保留这些数据，重新安装后可以继续使用。" IDNO mediagetKeepUserData

      ; 与模板处理 --delete-app-data 时同样的上下文切换：per-machine 卸载器是提权跑的，
      ; $APPDATA 会指到管理员账户上去。
      ;
      ; 删的是 userData（Electron 按 productName 建目录），所以必须用 ${PRODUCT_NAME} 而非
      ; ${APP_FILENAME}：后者由 executableName 派生，且 electron-builder 对带括号的 productName
      ; 会退回包名（beta 是「MediaGet (Beta)」）——用它删会删错目录。
      ${If} $installMode == "all"
        SetShellVarContext current
      ${EndIf}
      RMDir /r "$APPDATA\${PRODUCT_NAME}"
      ${If} $installMode == "all"
        SetShellVarContext all
      ${EndIf}
      DetailPrint "已删除本地数据目录"

      mediagetKeepUserData:
    ${EndIf}
  !macroend
!endif
