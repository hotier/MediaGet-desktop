# Windows Electron startup crash (0x80000003 / 0xc0000005) with sandbox enabled — findings & fix recommendation

Research date: 2026-10-14. All sources fetched and verified in this session.
Legend: **[C]** = CONFIRMED (the cited source states it). **[I]** = INFERRED (my reasoning over confirmed facts).
Nothing below is a fabricated issue number; where no number could be found, it says so explicitly.

---

## 0. Bottom line

There is **no single Electron issue that matches every one of the measured facts.** Two distinct, independently-documented root causes can produce "only `--no-sandbox` works" on Windows, and they are discriminated by a **2-command test** (§2). The measured flag matrix (only `--no-sandbox` works; `--disable-gpu`, `--disable-gpu-sandbox`, `--in-process-gpu` all fail) matches **exactly one** published report: **#54552 (Indirect Display Driver adapters)**. The mechanism best supported by Electron maintainers and by a **merged, shipped** fix is the **LPAC / AppContainer-ACL class (#51761 + #49143 + PR #54382)**. Both must be tested, because their fixes are completely different.

Critically: **Electron 44.5.0 shipped a change that converts this exact ACL crash into a named error message** ([v44.5.0 release notes](https://github.com/electron/electron/releases/tag/v44.5.0)). The affected machine runs **44.7.2**, which contains that change. If the crash were the ACL class, the app should now abort with a `FATAL` log naming the install folder and the `icacls` command — not a bare crash. **[I]** The absence of such a message is evidence *against* the pure ACL class and *toward* the IDD/GPU-topology class — **provided logging was actually captured** (see the logging caveat in §2.3).

---

## 1. Q1 — Known root cause(s)

### 1A. The LPAC / AppContainer-ACL class — CONFIRMED, with an authoritative mechanism statement

The single most authoritative statement of the mechanism is the body of the **merged Electron PR #54382** by `codebytere` (Electron MEMBER), which is the fix that shipped in 44.5.0 — <https://github.com/electron/electron/pull/54382>:

> "Sandboxed children run with a restricted token, and Windows checks a restricted token against a DACL containing any AppContainer package SID (`S-1-15-2-*`) as if it were an AppContainer: only `ALL APPLICATION PACKAGES` or `ALL RESTRICTED APPLICATION PACKAGES` can grant. Per-user install folders under `%LOCALAPPDATA%` (Squirrel.Windows, per-user NSIS) inherit package ACEs left by other software and carry neither, so every sandboxed child was denied its own install directory and died opening `icudtl.dat`, GPU process first. Program Files installs inherit `ALL APPLICATION PACKAGES` read access, which is why Chrome never sees this."

> "Confirmed on a Windows 11 VM with stock 44.4.3: one `S-1-15-2-` ACE on the folder reproduces the crash loop, auditing shows the children's `icudtl.dat` opens failing in the restricted-SID pass, and granting either well-known package group fixes it."

This is a **reproduced, maintainer-authored, merged** root cause for the class — the strongest evidence obtained in this research.

Corroborating, independent evidence:

- **electron/electron#51761** (OPEN, 34 comments, 27 👍, labels `platform/windows`, `crash`, `bug`, `has-repro-comment`, `42-x-y`) — <https://github.com/electron/electron/issues/51761>. Title: *"[Bug] Electron apps crash with exit_code=-2147483645 (GPU process sandbox crash) when zombie SIDs exist in DACL"*. **[C]** Reporter's reproducible A/B: `icacls "$env:LOCALAPPDATA\Programs\Microsoft VS Code" /grant "*S-1-15-2-999-999-999:(OI)(CI)(F)"` → crash; `icacls ... /reset` → works. **[C]** Cross-test: "if both the unknown zombie SID and the `S-1-15-2-2` permission exist at the same time, the application can start successfully without crashing."
- **electron/electron#51770** — <https://github.com/electron/electron/issues/51770>. **[C]** Symbolized stack from a real dump (exact pdb match):
  `electron!base::i18n::InitializeICUFromDataFile` ← CHECK fails → `base::i18n::InitializeICU` → `content::ContentMainRunnerImpl::Initialize` → `content::RunContentProcess` → `content::ContentMain` → `wWinMain`. `CHECK(InitializeICU())` trips → `base::ImmediateCrash` → child exits **0x80000003**. The browser only sees the child vanish and aborts via `content::IntentionallyCrashBrowserForUnusableGpuProcess` ("GPU process isn't usable. Goodbye."). **[C]** That issue explicitly states: **"Ruled out: HVCI off"** — i.e. on that reporter's machine turning HVCI off did **not** fix it. Closed as duplicate of #51761.
- **electron/electron#52098** (CLOSED as duplicate of #51761 by `MarshallOfSound`) — <https://github.com/electron/electron/issues/52098>. **[C]** The reporter first blamed a Windows cumulative update, then **retracted it with a timeline**: the app was already crashing before the update was installed. **[C]** Confirmed root cause on that machine: `%LOCALAPPDATA%` contained three inherited, unresolvable `S-1-15-2-*` SIDs, `%APPDATA%` two more, none resolvable in the HKCU/HKLM `AppContainer\Mappings` trees, and the app install contents **lacked read/execute for `S-1-15-2-2`**. **[C]** Two isolated A/B repairs (Discord and Notion): adding **only** `S-1-15-2-2` read/execute made both launch "with the sandbox enabled" and "without `--no-sandbox` or GPU-related flags", while "the orphaned SIDs remain present". **[C]** Reporter's conclusion: *"the child processes were dying during sandbox/early file initialization because they could not access required application files. The 'GPU process crashed' message was misleading; actual GPU rendering was not the root cause."* **[C]** On version: *"I cannot identify a specific Electron version that introduced the problem. The same ACL condition affected applications using different Electron versions."*
- **electron/electron#49143** (OPEN, maintainer-filed `jkleinsc`, label `upgrade-follow-up`) — <https://github.com/electron/electron/issues/49143>. This is the Chromium-lineage issue: Chromium CL [7204292](https://chromium-review.googlesource.com/c/chromium/src/+/7204292) turned the **network sandbox on by default on Windows**, and Electron CI immediately hit **[C]**:
  `ERROR:sandbox\policy\win\sandbox_win.cc:777] Sandbox cannot access executable ...\electron.exe. Check filesystem permissions are valid. See https://bit.ly/31yqMJR.: Access is denied. (0x5)`
  `FATAL:sandbox\policy\win\sandbox_win.cc:565] DCHECK failed: false.`
- Affected-app list accumulated across #51761: Discord, Bitwarden, LM Studio, Postman, VS Code, Figma, Signal Desktop, Notion, Proton Mail, GitHub Desktop, Deezer, Obsidian, Xiaoyunque, Hermes Desktop, OpenCode Desktop, Google Antigravity.
- **CONFIRMED** named ACE source: Google Antigravity's MSIX sandbox leaves orphan `S-1-15-2-*` ACEs. **[C]** Repro from the #51761 reporter: force-stop an Antigravity shell command while its AI agent runs, reopen the app → it cannot start and the unknown SID is in the DACL. **[C]** Also reported as **Oray Sunflower (向日葵远程控制)** in another case (#51761 comment 2026-06-27).

### 1B. The Indirect Display Driver (IDD) / GPU-topology class — the flag matrix that matches the measurement

- **electron/electron#54552** (OPEN, label `blocked/upstream`, `43-x-y`, `44-x-y`) — <https://github.com/electron/electron/issues/54552>. Title: *"Windows: Electron apps crash at launch (exit_code=-2147483645) when Indirect Display Driver adapters are present"*. **[C]** Three apps on three Electron majors fail identically: Kimi Desktop 43.6.0, ZCode 41.0.3, DeepSeek Harness 44.0.0 — the reporter explicitly states *"this is not a version regression."* **[C]** The verbatim flag table:

  | Flag | Result |
  |---|---|
  | `--no-sandbox` | **3/3 works** (all three apps) |
  | `--disable-gpu-sandbox` | 0/3 |
  | `--disable-gpu` | 0/3 |
  | `--disable-gpu-compositing` | 0/3 |
  | `--use-angle=d3d11` / `d3d11on12` / `gl` / `swiftshader` | 0/3 |
  | `--in-process-gpu` | 0/3 |

  **[C]** This is a **character-for-character match** to the measured machine's matrix (only `--no-sandbox` works). **[C]** The reporter also rules out the ACL class on that machine: no orphaned/unresolvable SIDs, installs not under `%LOCALAPPDATA%\Programs`, `icacls` shows no Unknown Account entries. **[C]** Proposed cause: `CollectDriverInfoD3D()` in `gpu/config/gpu_info_collector_win.cc` walks DXGI adapters in a plain loop, takes index 0 as primary, with no check of `DXGI_ADAPTER_FLAG_SOFTWARE`, no check of `D3DKMT_ADAPTERTYPE.IndirectDisplayDevice`, and no PCI preference; the IDD adapters (`ROOT\DISPLAY\0000`, `ROOT\DISPLAY\0001`) enumerate **before** the real PCI adapter. **[C]** On Windows `GpuProcessHost::GetFallbackCrashLimit()` is hard-coded to 3, stack HARDWARE → DISPLAY_COMPOSITOR → SOFTWARE_GL; the machine sees 6 GPU deaths, i.e. it dies after every fallback including software. **[C]** Correction in a later comment from the same reporter: `--no-sandbox` alone works, but `--no-sandbox --disable-gpu` still crashes — i.e. **two layered failures**, and fixing one is not enough.
- Independent corroboration **[C]**: `fathah/hermes-desktop#592` (2026-06-08) reports the identical signature with Todesk Virtual Display Adapter + GameViewer Virtual Display Adapter on Windows 10 22H2 19045 — same `exit_code=-2147483645`, same `0x80000003`, same "GPU process isn't usable. Goodbye.", **still open with zero maintainer response after ~4 months.**
- **electron/electron#54614** (OPEN, label `blocked/need-repro`, `44-x-y`, only a triage-bot comment) — <https://github.com/electron/electron/issues/54614>. **[C]** OS build **26300.9550 = Windows 11 26H2** — the *exact* build family of the affected machine. Electron 44.4.1. But **[C]** the signature differs: the **renderer** dies with `int 3` inside V8 (`v8::Isolate::InstallConditionalFeatures`, `OptimizingCompileTaskExecutor`, `v8::JSON::Parse`), and **[C]** `--no-sandbox` "did not provide a usable workaround" there. **[C]** No maintainer root cause; the bot asked for a standalone Fiddle testcase and said it would close in 10 days. **There is no confirmed 26H2-specific root cause in Electron's tracker.**

### 1C. Other distinct causes that must be excluded (each documented, each different)

| Cause | Issue | Distinguishing signal |
|---|---|---|
| MSIX/AppX + Code Integrity rejects an injected/bundled DLL (`SuperResExt.dll`, `vk_swiftshader.dll`) | [#53859](https://github.com/electron/electron/issues/53859) (closed `not_planned`), [#52700](https://github.com/electron/electron/issues/52700) (fixed by [#53174](https://github.com/electron/electron/pull/53174)) | Only for **MSIX-packaged** apps; exit code `101457950 = 0x060C201E`; Code Integrity Event **3033** in `Microsoft-Windows-CodeIntegrity/Operational`; `--in-process-gpu` and `--disable-gpu-sandbox` **work**. #53859 explicitly **ruled out** #51761 for its machine. |
| GPU process launch failure from a network share | [#36698](https://github.com/electron/electron/issues/36698) (open since 2022) | `gpu_process_host.cc(996) GPU process launch failed: error_code=18`; only when running from a mapped drive; `--no-sandbox` works. |
| Zombie/unknown SIDs in the DACL | [#51761](https://github.com/electron/electron/issues/51761) | see §1A |
| IDD / non-PCI adapters | [#54552](https://github.com/electron/electron/issues/54552) | see §1B |
| `app.enableSandbox()` **plus** `--no-sandbox` | [#54838](https://github.com/electron/electron/issues/54838) | Crashes the **main** process with `0xC0000005`; Electron 44.7.0; closed `not_planned`. Relevant if you gate `--no-sandbox` in code. |

### 1D. HVCI / VBS — NOT established as a cause

- **[C]** `#51770` states **"Ruled out: HVCI off"**: disabling HVCI did not fix it on that machine.
- **[C]** `#53859` had "Device Guard: HVCI + System Guard Secure Launch active (`SecurityServicesRunning {2,3}`)" and was **closed `not_planned`**; its A/B showed removing a Microsoft MSIX package (not HVCI) was the fix.
- **[C]** Microsoft documents the exact WMI semantics needed to read the machine's posture — <https://learn.microsoft.com/en-us/windows/security/hardware-security/enable-virtualization-based-protection-of-code-integrity>: `SecurityServicesRunning` `2` = memory integrity (HVCI) running, `3` = System Guard Secure Launch; `CodeIntegrityPolicyEnforcementStatus` `0`=Off/`1`=Audit/`2`=Enforced; `VirtualizationBasedSecurityStatus` `2` = enabled and running. The machine's `{2}` / `2` / `2` therefore means **HVCI running + kernel CI enforced**.
- **[I]** HVCI is best treated as a **precondition/amplifier**, not the root cause: it is what makes the AppContainer/code-integrity checks *enforced* rather than advisory, so an ACL or signing-policy violation becomes fatal. No source found ties HVCI directly to this crash.
- **[I]** Turning HVCI off is a real but **inappropriate** mitigation: it lowers the machine's security posture globally, is documented to break driver compatibility (same MS doc), and — per #51770 — has been shown not to fix this class anyway.

---

## 2. Q2 — Is it a version regression? Which version fixes it? What to pin?

**No version regression, and no known-good Electron version to pin.**

- **[C]** `#54552`: Electron **41.0.3, 43.6.0 and 44.0.0** all fail identically on the affected machine; the reporter states this explicitly. **[C]** `#51761`: Electron 42.2.0 and 37.6.0. **[C]** `#51770`: Electron 40.8.5. **[C]** `#52098`: Electron 42.4.1 and 37.6.0. **[C]** `#52098`'s reporter: *"I cannot identify a specific Electron version that introduced the problem."* **[C]** `#53859`: two apps with *different* bundled Electron versions both died. The class spans Electron 37 → 44.
- **[C]** The one genuine version boundary found is **unrelated to this crash**: Chromium CL 7636200 (Chromium 148 → **Electron 42 and later**) made the `vk_swiftshader.dll` preload conditional, creating the MSIX Code-Integrity failure; **Electron 41 is unaffected** because its Chromium predates the CL — stated in [PR #53174](https://github.com/electron/electron/pull/53174).
- **[C]** As of 2026-10-14 all three majors are still receiving patch releases simultaneously (v44.7.2 at 01:27Z and v42.11.14 at 03:01Z), i.e. maintainers have not frozen any line in response.
- **[C]** **v44.7.2 — the exact version on the affected machine — contains no Windows sandbox/ACL/GPU-startup fix.** Its complete release notes: macOS background-click fix (#54819), macOS interrupted-update fix (#54844), "Backported fixes from upstream ANGLE, Chromium, PDFium and V8" (#54898), docs (#54880). Source: <https://api.github.com/repos/electron/electron/releases/latest>.

**What *did* ship, and when — this matters a lot:**

- **[C]** **Electron 44.5.0** (2026-09-29) — <https://github.com/electron/electron/releases/tag/v44.5.0> — contains:
  * *"Fixed the GPU process crash-looping on Windows when the sandbox cannot read the install folder; the folder is now reported instead. [#54484] (Also in 43 [#54485], 45 [#54483])"*
  * *"Added launch-failure reporting with `systemErrorCode` to the `app` `child-process-gone` event. [#54231] (Also in 45 [#54230])"*
- **[C]** The originating PR is [#54382](https://github.com/electron/electron/pull/54382) (merged 2026-09-27), backported as [#54484](https://github.com/electron/electron/pull/54484) (44-x-y), [#54485](https://github.com/electron/electron/pull/54485) (43-x-y), [#54483](https://github.com/electron/electron/pull/54483) (45-x-y).
- **[C]** The fix is **diagnostic, not reparative**: *"After this change an app whose Windows install folder ACL has a stray AppContainer entry stops at startup with an error that names the folder and the `icacls` command that fixes it... **The ACL itself is left to installers.**"*
- **[I]** Consequence for this investigation: **on 44.7.2, the ACL class should now surface as a named `FATAL`, not a silent crash.** Since the affected machine runs 44.7.2 and reportedly produces no message, either (a) the crash is a different class, or (b) the message was never captured. See §2.3.

**Ranked "what to pin / what to upgrade to":**

1. **Do not downgrade.** **[C]** No Electron version is known-good for this class, and downgrading loses the 44.5.0 diagnostic that tells you which class you are in.
2. **Stay on ≥ 44.5.0** (44.7.2 is fine and already includes it) so the ACL class self-reports. **[I]** Upgrading to the newest 44.x is therefore worth doing *before* further triage, purely for diagnosability.
3. **If the ACL class is confirmed, no version change is needed** — the fix is installer-side (§3.1). **[C]** Maintainer `nikwen` on #51761: an Electron-side fix "would take months for all applications to upgrade"; the practical fix is on the app/installer side.
4. **[C]** If the IDD class is confirmed, **there is no Electron version to pin** — #54552 is `blocked/upstream` and unfixed; the only working flag is `--no-sandbox`.

### 2.3 Logging caveat (important)

**[C]** Electron's docs state: *"On Windows, logs from child processes cannot be sent to stderr. Logging to a file is the most reliable way to collect logs on Windows."* — <https://www.electronjs.org/docs/latest/api/command-line-switches>. **[C]** The same page documents `--enable-logging[=file]`. **[I]** Additionally, `electron.exe` is a Windows **GUI-subsystem** binary, so Chromium's stderr output is not attached to the launching console by default. **Therefore "zero stdout" is not reliable evidence that no JS ran or that no diagnostic was emitted.** Before concluding anything from the absence of output, re-run with:

```
--enable-logging=file --log-file=C:\temp\electron-crash.log
```

and read the file. This is the single cheapest next step and it discriminates §1A from §1B almost by itself.

---

## 3. Q3 — Recommended fix that keeps the renderer sandbox ENABLED

### 3.1 ACL / LPAC class — **CONFIRMED working, sandbox stays on**

**The canonical, maintainer-stated requirement** is comment `3618354787` by **`deepak1556` (Electron MEMBER)** on #49143, 2025-12-05 — <https://github.com/electron/electron/issues/49143#issuecomment-3618354787>:

> "Apps should update the app container SID with appropriate filesystem ACL, needs to be done as part of their installers. Current requirement is the `icacls /grant *S-1-15-2-2:(OI)(CI)(RX)`"

**Exact command (additive; nothing removed, sandbox untouched):**

```powershell
icacls "<INSTALL_DIR>" /grant "*S-1-15-2-2:(OI)(CI)(RX)" /T /C
```

**Status per candidate:**

| Candidate | Status | Evidence |
|---|---|---|
| Additive `S-1-15-2-2` read/execute on the install dir | **CONFIRMED working, sandbox ON** | #51761 comments: `Classic298` (Signal Desktop), `alucard7758` (Obsidian + Xiaoyunque), `1458436854ghf` (Hermes/OpenCode/GitHub Desktop), `XPersPective` (Antigravity); #52098's self-corrected A/B (Discord + Notion). All report launch **without** `--no-sandbox` / `--disable-gpu-sandbox`. |
| `S-1-15-2-1` (`ALL APPLICATION PACKAGES`) instead | **CONFIRMED working** | [PR #54382](https://github.com/electron/electron/pull/54382) names `icacls "<dir>" /grant *S-1-15-2-1:(OI)(CI)(RX)` as the command its FATAL message prints; the PR body says "only `ALL APPLICATION PACKAGES` or `ALL RESTRICTED APPLICATION PACKAGES` can grant." |
| `icacls "<dir>" /reset` | **CONFIRMED working but destructive** | #51761 repro. **[I]** Resets the folder to inherited ACEs — it removes the orphan SIDs *and* any custom grants. Prefer the additive form. |
| Removing the orphan `S-1-15-2-*` ACEs | **Often impossible** | **[C]** #51761 `Classic298`: the orphans survive only as *inherited* `(I)` copies, and "you can't remove an inherited ACE" — the parent must be fixed instead. |
| Granting **at runtime from the main process** before the first sandboxed child spawns | **CONFIRMED working (by the fix's author)** | **[C]** PR #54382: *"an earlier revision of this branch that granted the ACE at runtime started normally where 44.4.3 crash-looped."* **[I]** This is a legitimate app-side fallback **if** JS actually runs (it does not help a pre-JS crash). |
| Windows-side setting | **No confirmed Windows setting fixes this.** **[C]** #51761 reporter tried reinstalling drivers, software, Windows, adjusting Core Isolation and HAGS, updating BIOS — nothing worked except the DACL fix. **[I]** The only Windows-side "fix" is turning HVCI off, which #51770 shows does not work and which is not recommended. | |

**Installer implementation (electron-builder / NSIS) — CONFIRMED surface, INFERRED recipe:**

**[C]** electron-builder exposes `nsis.include` (default `build/installer.nsh`) and the macros `customHeader`, `preInit`, `customInit`, `customInstall`, `customUnInstall`, `customRemoveFiles`, `customInstallMode`, … with `BUILD_RESOURCES_DIR` and `PROJECT_DIR` defined and `build` on `addincludedir` — <https://www.electron.build/nsis.html>. **[C]** It also documents `${ifNot} ${isUpdated} … ${endIf}` to run code only on a fresh install rather than an update. **[C]** **There is no first-class electron-builder option for this ACL grant** — a custom macro shelling out to `icacls` is the only supported route. **[I]** Concrete shape:

```nsis
; build/installer.nsh   (referenced by nsis.include, or picked up by default)
!macro customInstall
  DetailPrint "Granting Windows sandbox access to $INSTDIR"
  nsExec::ExecToLog 'icacls "$INSTDIR" /grant *S-1-15-2-2:(OI)(CI)(RX) /T /C'
!macroend
```

**[C]** Real precedent — a production app shipped exactly this: **anomalyco/opencode PR #46696**, *"fix(desktop): grant Windows sandbox access during installation"*, merged 2026-09-02 — <https://github.com/anomalyco/opencode/pull/46696>:

> "Grant `ALL RESTRICTED APPLICATION PACKAGES` inheritable read/execute access to `$INSTDIR` after NSIS extraction, **including updates**, following [Electron's installer guidance]." … "Prevent the ACL-triggered Electron startup failure without disabling sandboxing, removing existing permission entries, or changing permissions outside the installation directory."

**[I]** Note the "including updates" point — it matters, because **[C]** #51761 `Classic298` found that an in-place Squirrel/electron-builder auto-update **re-inherits the polluted DACL without re-stamping the ACE**, resurrecting the crash without any new install. **[I]** Therefore the grant must run on **every install/update path**, not only first install (i.e. do **not** wrap it in `${ifNot} ${isUpdated}`).

**[C]** For Squirrel.Windows / zip / portable distribution there is no equivalent: **[C]** maintainer `deepak1556` on #49143 — *"the options for zip format is asking users to update the permissions or run without lpac sandbox."* **[C]** Chromium's own helper for this is `build/win/set_appcontainer_acls.py` (cited by the same maintainer) — <https://source.chromium.org/chromium/chromium/src/+/main:build/win/set_appcontainer_acls.py>.

### 3.2 IDD / GPU-topology class — **no sandbox-preserving fix exists**

- **[C]** #54552 is `blocked/upstream`; the only flag that works is `--no-sandbox`, and the reporter states outright that `--no-sandbox` "is not an acceptable fix for end users."
- **[C]** The proposed upstream fixes (skip `DXGI_ADAPTER_FLAG_SOFTWARE` / `ROOT`-bus / `D3DKMT_ADAPTERTYPE.IndirectDisplayDevice` adapters when picking the primary GPU; degrade to GPU-disabled instead of killing the browser; surface the real reason) are **proposals in an issue body, not merged code**.
- **[C]** Removing the IDD adapter is not viable on the reported machine: the IDD devices are load-bearing (one is created by an Android-emulator component, another is the remote-control display; "disabling the virtual display ends the remote session").
- **[I]** A narrow, unverified option: if the machine has IDD adapters, try `--use-angle=…` variants — but **[C]** all four were tested 0/3 in #54552, so this is not promising.
- **[C]** `--disable-features=RendererCodeIntegrity` (already tested on the affected machine, same crash) targets the **code-integrity** class (#52700/#53859), not either class above — **[I]** which is consistent with it having no effect.

### 3.3 Ranked recommendation list (apply in this order)

1. **Capture real logs first** (cheap, decisive):
   `--enable-logging=file --log-file=C:\temp\electron-crash.log`
   Look for the 44.5.0+ message naming the install folder + `icacls` (→ §3.1), or `gpu_process_host.cc … exit_code=…` / Code Integrity Event 3033 (→ §1C).
2. **Run the 2-command discriminator** (below).
3. **If ACL class** → ship the additive `S-1-15-2-2` grant in the installer (and in every update path), keep the sandbox fully enabled. Do not use `--no-sandbox`.
4. **If IDD class** → there is no sandbox-preserving fix today; escalate upstream on #54552 / file with Microsoft. In the meantime, a **conditional, last-resort, user-visible** `--no-sandbox` fallback is the only thing that keeps the app usable — see §4 for how to do that without shipping it unconditionally.
5. **If Code-Integrity class** (MSIX only) → `--enable-unsafe-swiftshader` or remove the offending injected package; see #52700 / #53859.

### 3.4 The 2-command discriminator (do this before choosing a fix)

```powershell
# (a) Is this the ACL/LPAC class?
icacls "$env:LOCALAPPDATA\Programs\<YourAppDir>"          # look for S-1-15-2-* entries and for the ABSENCE of S-1-15-2-2 / S-1-15-2-1
# (b) Is this the IDD/GPU-topology class?
Get-PnpDevice -Class Display | Format-Table FriendlyName, InstanceId, Status -Auto
#     look for ROOT\DISPLAY\.... adapters (Indirect Display Driver / virtual display), especially enumerated before a PCI adapter
```

**[I]** Interpretation: `S-1-15-2-*` present **and** `S-1-15-2-2`/`S-1-15-2-1` absent → §3.1 (fixable, sandbox stays on). `ROOT\DISPLAY\*` IDD adapters present and no ACL anomaly → §3.2 (no fix). Also check whether the app is installed under `%LOCALAPPDATA%` (per-user) vs `Program Files`: **[C]** per PR #54382, `Program Files` installs inherit `ALL APPLICATION PACKAGES` read access "which is why Chrome never sees this" — so a Program Files install makes §3.1 unlikely.

---

## 4. Q4 — Is `--no-sandbox` the only workaround? Security implications & standard practice

**Is it the only workaround?**

- **[C]** For the **IDD class**, yes — it is the only flag that works (#54552: 3/3, everything else 0/3; #36698 likewise).
- **[C]** For the **ACL class**, **no** — the additive ACL grant fixes it with the sandbox fully enabled, and multiple independent reporters confirm this.
- **[I]** So `--no-sandbox` is the only *flag*, but not the only *workaround*.

**Exact security implications — Electron's own wording:**

- **[C]** `--no-sandbox`: *"Disables the Chromium sandbox. Forces renderer process and Chromium helper processes to run un-sandboxed. **Should only be used for testing.**"* — <https://www.electronjs.org/docs/latest/api/command-line-switches>.
- **[C]** Tutorial/sandbox: *"We highly recommend that you only use this flag for testing purposes, and never in production."* It disables the sandbox **for all processes, including utility processes** — <https://www.electronjs.org/docs/latest/tutorial/sandbox>.
- **[I]** Concretely, this removes the primary containment boundary protecting the user's machine from a compromised renderer (malicious page content, a hijacked remote resource, an XSS in bundled web content). A renderer escape then runs with the user's full token and, on this machine, with HVCI/VBS still on but no Chromium process-level isolation. **[C]** Microsoft's AppContainer documentation describes the isolation being forfeited — <https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation>.
- **[C]** Extra trap: **`app.enableSandbox()` combined with `--no-sandbox` crashes the main process with `0xC0000005`** — electron/electron#54838, Electron 44.7.0, closed `not_planned` — <https://github.com/electron/electron/issues/54838>. **[I]** If you add a conditional `--no-sandbox`, audit for any `app.enableSandbox()` call.

**Standard practice for apps that must (placement + gating):**

- **[C]** Placement: `app.commandLine.appendSwitch(switch, value)` must run *"in your app's main script **BEFORE** the ready event of the app module is emitted"* — <https://www.electronjs.org/docs/latest/api/command-line-switches>.
- **[C]** `app.enableSandbox()` "has to be called before the app's ready event" — <https://www.electronjs.org/docs/latest/tutorial/sandbox>.
- **[I]** **Gating pattern.** Because a pre-JS crash cannot be detected in-process (§5), the switch must be gated on something that *can* be evaluated before the crash — i.e. **outside the app**, not by a runtime probe:

```js
// main.js — FIRST lines, before app.whenReady()
const { app } = require('electron')

// Gate on an explicit, persisted, user/ops-visible opt-in — NOT on a runtime probe,
// because the failure mode kills the process before any JS runs.
if (process.env.APP_DISABLE_SANDBOX === '1' ||
    require('fs').existsSync(require('path').join(app.getPath('userData'), 'no-sandbox.flag'))) {
  app.commandLine.appendSwitch('no-sandbox')   // MUST be before ready
  app.commandLine.appendSwitch('disable-gpu-sandbox') // only if it also helps; it does not for the IDD class
}
```

**[I]** Rationale for the file/env gate: the installer or a support procedure can create the flag file, so affected users get a working app while everyone else keeps the sandbox. **[I]** Do **not** ship `--no-sandbox` unconditionally; do **not** gate it on `process.sandboxed` (that property is only meaningful *inside* a renderer and is `undefined` when unsandboxed — <https://www.electronjs.org/docs/latest/api/process>).

---

## 5. Q5 — Runtime detection of a failed sandbox, for graceful degradation

**There is no programmatic API.** The authoritative answer is from **`deepak1556` (Electron MEMBER)** on #49143, comment `3637882468`, 2025-12-10 — <https://github.com/electron/electron/issues/49143#issuecomment-3637882468>:

> *"Thats a valid suggestion, we can log and exit with an informative error when the sandbox is not usable with an early detection similar to [zygote_host_impl_linux.cc:128-139]."*
> *"I wouldn't add a fuse for this but a cli flag to opt-out similar to `--disable-gpu-sandbox` we have today."*
> *"**chrome://sandbox page is available for all electron apps that has the required information for each process.**"*

**[C]** So: no API was implemented; the only sanctioned inspection surface is the **`chrome://sandbox` page** (human-readable, not programmatic). **[C]** The early-detection mechanism the maintainer points at is Chromium's `content/browser/zygote_host/zygote_host_impl_linux.cc:128-139` — <https://source.chromium.org/chromium/chromium/src/+/main:content/browser/zygote_host/zygote_host_impl_linux.cc;l=128-139>.

**What Electron *does* give you, and its hard limit:**

- **[C]** `app.on('child-process-gone', (event, details) => …)` — <https://www.electronjs.org/docs/latest/api/app#event-child-process-gone>. `details` includes:
  * `type`: `'Utility' | 'Zygote' | 'Sandbox helper' | 'GPU' | 'Pepper Plugin' | 'Pepper Plugin Broker' | 'Unknown'`
  * `reason`: `'clean-exit' | 'abnormal-exit' | 'killed' | 'crashed' | 'oom' | 'launch-failed' | 'integrity-failure' | 'memory-eviction'` — where **`'integrity-failure'` is documented as "Windows code integrity checks failed"**
  * `exitCode` (number), and `systemErrorCode` (number, **Windows only**, `GetLastError()`, **set only when `reason === 'launch-failed'`**)
  * `serviceName`, `name`
  * Documented as: *"Emitted when the child process unexpectedly disappears… **It does not include renderer processes.**"* (renderers come via `app.on('render-process-gone', …)`).
- **[C]** `systemErrorCode` on that event was **added in Electron 44.5.0** via [PR #54231](https://github.com/electron/electron/pull/54231) (also in 45 via #54230) — <https://github.com/electron/electron/releases/tag/v44.5.0>.
- **[I]** **The hard limit, and it applies here:** the measured failure kills the process **before any JS executes**. No `child-process-gone` handler, no `process.sandboxed` check, and no in-app probe can run. **[C]** `#51770` states this explicitly for the ACL class: *"Because the abort is this early, the child writes no log and no crash dump."* **[I]** Therefore this event is useful **only after** a fix restores main-process startup, or for the *degraded* case where the browser survives and children die (which is the ACL class's normal presentation).
- **[I]** Practical graceful-degradation recipe for the case where JS *does* run: on `child-process-gone` with `details.type === 'GPU'` and `reason` in `{'crashed','launch-failed','integrity-failure'}`, count occurrences; after N, persist the `no-sandbox.flag` (§4) and relaunch via `app.relaunch()` + `app.exit()`, so the next launch is the gated un-sandboxed one. **[I]** This cannot help a pre-JS crash — for that, the only graceful path is an **installer-side preflight** that verifies/repairs the ACE before first launch, which is exactly what §3.1 does.

---

## 6. What could NOT be found (stated explicitly, not invented)

- **No Chromium bug-tracker number could be verified for this crash class.** `https://issues.chromium.org/issues/516312113` and search URLs return only a Google sign-in shell (the tracker is not readable anonymously), and the legacy `https://bugs.chromium.org/p/chromium/issues/detail?id=973695` returns an empty body (Monorail retired/migrated). The only Chromium references available are **second-hand**, quoted inside Electron issues: `516312113` (the original filing of #51770) and legacy bug `973695` (about `InitializeAndStartSandbox` looking up devices in fallback databases — cited in #54552, **not** about HVCI or ACLs).
- **No authoritative statement that HVCI/VBS causes this crash** — and #51770 explicitly says HVCI was ruled out on that machine.
- **No Electron release that repairs this class.** 44.5.0+ only *reports* the ACL case.
- **No Electron docs page telling developers to grant `S-1-15-2-2`.** The guidance exists **only** in the #49143 comment thread (`3618354787`). Searches for such a page returned only generic Electron/Chromium homepages and tutorials.
- **No first-class electron-builder option** for the ACL grant (only `nsis.include` + a custom `customInstall` macro).
- **No issue matching all measured facts simultaneously.** #54552 matches the flag matrix; #51761/#52098/#54382 match the mechanism; #54614 matches the OS build. None matches all three.
- **No third-party write-up** tying Windows 11 26H2 (26300.x) to this Electron crash.

---

## 7. Source index

**Electron issues/PRs**
- #51761 (ACL/zombie-SID root cause, OPEN, 34 comments) — https://github.com/electron/electron/issues/51761
- #49143 (network sandbox default; installer guidance; chrome://sandbox) — https://github.com/electron/electron/issues/49143
  - comment 3618354787 (installer `icacls` requirement) — https://github.com/electron/electron/issues/49143#issuecomment-3618354787
  - comment 3637882468 (no detection API; chrome://sandbox) — https://github.com/electron/electron/issues/49143#issuecomment-3637882468
- #52098 (self-corrected A/B, ACL confirmed, closed as dupe) — https://github.com/electron/electron/issues/52098
- #51770 (ICU CHECK stack, 0x80000003, "Ruled out: HVCI off") — https://github.com/electron/electron/issues/51770
- #54552 (IDD adapters; exact flag-matrix match; blocked/upstream) — https://github.com/electron/electron/issues/54552
- #54614 (Windows 11 26H2 build 26300.9550; renderer V8 int3) — https://github.com/electron/electron/issues/54614
- PR #54382 (shipped diagnostic; root-cause mechanism; VM repro) — https://github.com/electron/electron/pull/54382
- Backports: #54484 (44-x-y), #54485 (43-x-y), #54483 (45-x-y)
- #53859 (MSIX + Code Integrity, closed not_planned) — https://github.com/electron/electron/issues/53859
- #52700 (vk_swiftshader CIG) — https://github.com/electron/electron/issues/52700 ; fix PR #53174 — https://github.com/electron/electron/pull/53174
- #36698 (network share, error_code=18) — https://github.com/electron/electron/issues/36698
- #54838 (`enableSandbox()` + `--no-sandbox` → main-process 0xC0000005) — https://github.com/electron/electron/issues/54838
- v44.5.0 release notes (the fix + `systemErrorCode`) — https://github.com/electron/electron/releases/tag/v44.5.0
- v44.7.2 release notes (no sandbox fix) — https://api.github.com/repos/electron/electron/releases/latest

**Third-party precedent**
- anomalyco/opencode PR #46696 (shipped NSIS ACL fix) — https://github.com/anomalyco/opencode/pull/46696
- fathah/hermes-desktop#592 (IDD corroboration, unreplied) — referenced inside #54552

**Official docs**
- Command-line switches (`--no-sandbox` wording, `appendSwitch` placement, `--enable-logging`) — https://www.electronjs.org/docs/latest/api/command-line-switches
- Sandbox tutorial (never in production; `app.enableSandbox()`) — https://www.electronjs.org/docs/latest/tutorial/sandbox
- `app` events (`child-process-gone`, `render-process-gone`) — https://www.electronjs.org/docs/latest/api/app#event-child-process-gone
- `process` (`process.sandboxed`, `process.windowsStore`) — https://www.electronjs.org/docs/latest/api/process
- electron-builder NSIS (`nsis.include`, `customInstall`, `${isUpdated}`) — https://www.electron.build/nsis.html
- Microsoft: memory integrity / VBS / Win32_DeviceGuard field semantics — https://learn.microsoft.com/en-us/windows/security/hardware-security/enable-virtualization-based-protection-of-code-integrity
- Microsoft: AppContainer isolation — https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation

**Chromium (all second-hand via Electron issues, except the two CLs)**
- CL 7204292 (network sandbox default on Windows) — https://chromium-review.googlesource.com/c/chromium/src/+/7204292
- `build/win/set_appcontainer_acls.py` — https://source.chromium.org/chromium/chromium/src/+/main:build/win/set_appcontainer_acls.py
- Early-detection model — https://source.chromium.org/chromium/chromium/src/+/main:content/browser/zygote_host/zygote_host_impl_linux.cc;l=128-139
- CL 7636200 (SwiftShader preload conditionality, Chromium 148 → Electron 42+) — cited in PR #53174
