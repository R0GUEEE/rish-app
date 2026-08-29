# Guest 挂载探路 spike —— 可行性结论与集成点清单

Date: 2026-08-29
Scope: `dsh-app` parity 矩阵标注 "persistent rish guest 未在 app 内挂载，包镜像
staging 无消费方"。本 spike 只求结论，不合入。

## 结论：可行，但有明确前置条件

**在 Rish app 内 boot rish guest 并让 staged Alpine APK 镜像被真实消费是可行的**，
技术路径完整存在，没有平台级阻断。但当前缺三样东西，全部是工程投入而非可行性
问题。

## 已验证的事实链

1. **FFI 完整**：`rish_ffi.xcframework`（arm64 device + simulator 双 slice）导出
   `rish_vm_boot_session` / `rish_vm_session_exec_json` /
   `rish_vm_session_free`（交互式长驻 guest）和 `rish_vm_run_docker_json`
   （单命令一次性 guest）。头文件注释明确：kernel/initramfs 以 bundle resource
   路径传入，大文件不跨 ABI。
2. **参考实现存在**：`rish/examples/ios-vm/RishVMDemo.swift` + 
   `run-vm-simulator.sh` 已在 iPhone Simulator 上跑通过完整 boot（`uname -a`
   in-guest）。它加载 `vmlinuz-virt-6.18.35` + `rish-container.cpio`。
3. **镜像 staging 已实现**：dsh-app 的 `LocalMirrorsModule.applyMirrors` 把
   Alpine repositories / pip.conf / .npmrc 写入
   `Application Support/rish-guest-overlay/`，receipt 含
   `guest_runtime_mounted: false` —— 就差消费方。
4. **guest overlay 挂载语义**：`rish/guest/x86_64/build-container-initramfs.sh`
   的构建流程显示 container initramfs 以 overlay 方式把
   `container-overlay/` 拷进 minirootfs。这意味着 APK 镜像配置必须在
   **构建期**进 initramfs，或者在 **运行期**通过 root_disk/挂载点注入。

## 缺失的三件事（按顺序）

1. **guest 镜像资产**：`rish/guest/x86_64/out/` 下当前没有已构建的
   kernel/initramfs（`.cpio` 缺失）。需要先在 Mac 上跑
   `build-container-initramfs.sh`（依赖 minirootfs 下载 + 可复现构建），
   产物约几十 MB，要作为 app bundle resource 打进 DSHMobile。
2. **镜像配置注入路径**：app 内的 overlay 在
   `Application Support/rish-guest-overlay/`（运行期可写），而 demo 的
   initramfs 是只读 bundle 资源。需要选一条：
   - a) `root_disk_path` 挂一个包含 `/etc/apk/repositories` 的小磁盘（FFI
     已支持 `root_disk_path`），运行期把 staged overlay 放进 root disk；
   - b) 构建期把默认镜像写进 container-overlay（失去运行期可配置性）。
   推荐 a：保留 LocalMirrors 的"staged → 下次 boot 生效"语义。
3. **boot 会话生命周期管理**：`rish_vm_boot_session` 阻塞且慢（注释明确
   要求 worker thread），需要 native 侧一个 session manager（boot / exec /
   shutdown + app 后台挂起时的处置策略）。这是纯 Obj-C 工程量。

## 集成点清单（真正实施时）

- `modules/rish/ios/Sources/` 新增 `LocalGuestModule.mm`：
  `bootGuest` / `guestExec` / `shutdownGuest` 三方法，串行 queue 管理
  session handle；boot 请求带 `root_disk_path` 指向由 staged overlay 组装的
  小磁盘。
- `LocalMirrorsModule.applyMirrors` 的 receipt 把
  `guest_runtime_mounted` 翻为 `true` 的时机：guest boot 成功并确认
  `/etc/apk/repositories` 内容匹配 staged 值之后（由 guestExec `cat` 验证）。
- bundle 资源：`vmlinuz-virt-*` + `rish-container.cpio` 进
  `DSHMobile/Resources`（Xcode folder reference，注意 ~40MB 包体影响，
  可能需要按需下载方案替代打包）。
- 验收路径：boot → `guestExec("apk update")` 确认走 staged 镜像源 →
  `apk add` 一个小包（如 busybox）成功 → proof 记录 guest boot 单元数。

## 建议排期

真正实施是"周"级：镜像构建管线打通（1-2 天）+ LocalGuestModule 与 session
生命周期（2-3 天）+ root disk 注入与验收（1-2 天）。包体 +40MB 需要产品
决策（打进去 vs 首次使用下载）。
