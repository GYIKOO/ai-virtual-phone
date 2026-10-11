# Float 小手机 · 安卓壳（FloatShell）

一个极薄的安卓 App 壳：全屏 WebView 直接加载你自己的线上站点，外加一个**不依赖 Google 服务**的离线推送长连接。目标用户：安卓机上收不到 Web Push 的用户（国行机无 GMS、或所在网络到不了 Google 推送服务器）。

## 它解决什么

| 能力 | 网页版（安卓 Chrome） | 安卓壳 |
| --- | --- | --- |
| 页面功能 | ✅ | ✅ 完全一致（加载同一网页） |
| 离线推送 | 依赖 FCM（需 GMS + 能连 Google） | ✅ 自建 Supabase Realtime 长连接，无 GMS 也能收 |
| 网页更新 | 自动 | ✅ 同样自动（壳只是浏览器，部署即生效） |

推送链路：`push-generate` 边缘函数生成完离线消息后，除了发 Web Push，还会向 Supabase Realtime 的个人频道 `shellpush:<userId>` 广播一份；壳内前台服务保持一条 WebSocket 长连接订阅该频道，收到即弹系统通知。设置页的「测试」按钮走同一条链路，可直接验证。

## 1.0.4 个人云推送与插件文件选择兼容

- 需要同时更新网页、重新部署个人云的离线推送函数、更新 APK；仅运行 SQL 或更新网页不能让旧 APK 获得该能力。
- 在「设置 → 云服务部署」配置个人离线推送后，到消息 App 的离线推送页开启本设备并测试。开启开关只表示已注册和保存配置，不保证长连接已连通。
- APK 经限定站点、限定主框架的原生桥接收公开连接密钥和随机设备通道，不接收个人云 service_role 管理密钥。设备标识与连接配置保存在不参与 Android 备份的目录。
- 退订只删除本设备的订阅；切换项目会断开旧个人云连接，不自动退回站点公共库。连接在前台服务存活期间接收实时通知，不保证强制停止、断网时的通知补投。
- JS-only 文件选择使用系统全部文件筛选，返回网页前核验 `.js` / `.mjs` 文件名；其他类型选择器不放宽。网页风险确认仍保留。
- 本地回归：`node scripts/test-shell-personal-push.cjs`、`node scripts/test-android-native.cjs`、`npm run check:push`。`android-shell/tests/PluginFilePolicyTest.java` 可与 `PluginFilePolicy.java` 一起用 javac 编译运行。
- 真机待验收：允许/拒绝通知、开启/关闭个人推送、测试通知、锁屏实际离线回复、重启后的重连、切换项目、其他设备订阅不受影响、JS 与误选文件的导入。未完成真机测试前不应宣称推送已修复。

## 1.0.3 下载与通知适配

- 网页生成的备份、图片等 Blob/data 文件通过系统「另存为」保存；选择位置后分块写入，完成才提示成功。取消或失败会清理本次创建的未完成文件，不删除已有备份。
- 「浏览器通知」在 APK 中转为原生系统通知，需要同时部署配套网页代码。它用于页面在后台时的消息提醒，不保证进程被系统终止后仍可运行；云端离线推送仍依赖原有服务和配置。
- 新的原生接口仅允许配置的站点主页面调用；旧 WebView 不支持能力桥时请更新 Android System WebView。
- 升级时使用与已安装版本相同的包名和签名。已有 release 安装应下载签名 release APK 覆盖安装，不能换成 debug，也不应卸载或清数据。
- 真机验收：小文件、大 ZIP 备份、取消保存、取消后重试、通知授权/拒绝、应用切到后台后的消息提醒。保存后的备份应能打开 ZIP 并读取内容；可在独立测试环境验证恢复，勿覆盖现有聊天数据。
- 自动检查：`node scripts/test-android-native.cjs`、`node scripts/test-android-web.cjs`（后者需要 `npm ci`）。

## 一键构建（GitHub Actions）

仓库已带工作流 `.github/workflows/android-shell.yml`：

1. 在自己的 GitHub 仓库打开 **Settings → Secrets and variables → Actions → Variables**，新建变量 `SHELL_SITE_URL`，值填写你自己的 HTTPS 站点地址。手动运行工作流时也可以临时填写 `site_url`，它会覆盖仓库变量。
2. 打开仓库 **Actions → Build Android Shell APK → Run workflow**，选择要构建的分支并运行。（自动触发规则以工作流文件中的配置为准。）
3. 构建结束后，在该次运行页面底部的 **Artifacts** 下载：
   - `float-shell-debug`：通常可以直接安装，适合测试；如果没有配置自己的密钥，它使用 GitHub Actions 本次运行生成的临时 debug 签名，不能保证后续构建仍可覆盖安装。
   - `float-shell-release`：只有配置好下面的个人签名密钥后，才会生成可用于长期分发的已签名 release APK。未配置时不要把它当作可安装的正式包。

## 配置自己的 APK 签名（推荐长期使用或分享 APK 时设置）

**每个维护者都应使用自己保管的签名密钥。** 不要向别人索要或分享你的密钥，也不要把密钥文件、密码提交到 Git 仓库。Android 要覆盖更新已安装的应用，通常必须使用同一把签名密钥；密钥丢失后，旧应用可能无法直接升级，用户或许只能卸载重装（可能丢失本地数据）。

### 第一步：在自己的电脑生成密钥库

电脑需要安装 JDK（含 `keytool`）。在终端运行：

```bash
keytool -genkeypair -v -keystore shell-release.jks -alias floatshell -keyalg RSA -keysize 2048 -validity 10000
```

按提示设置并妥善保存密钥库密码、密钥密码和别名。示例别名是 `floatshell`。请把生成的 `shell-release.jks` 和密码保存在安全位置，并另外做一份加密备份；不要上传到 GitHub 仓库。

### 第二步：将密钥库转为 Base64

Windows PowerShell 可在密钥库所在目录运行：

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes(".\shell-release.jks")) | Set-Clipboard
```

这会把 Base64 文本复制到剪贴板。它仍然等同于密钥文件本身，**不要发给别人或粘贴到公开位置**。

Linux/macOS 可运行：

```bash
base64 < shell-release.jks | tr -d '\n'
```

### 第三步：在 GitHub Actions 添加四个 Repository secrets

进入自己的仓库 **Settings → Secrets and variables → Actions → Repository secrets → New repository secret**，逐个添加：

| Secret 名称 | 填写内容 |
| --- | --- |
| `SHELL_KEYSTORE_BASE64` | 第二步生成的完整 Base64 文本 |
| `SHELL_KEYSTORE_PASSWORD` | 创建密钥库时设置的密钥库密码 |
| `SHELL_KEY_ALIAS` | 创建时使用的别名，例如 `floatshell` |
| `SHELL_KEY_PASSWORD` | 对应别名的密钥密码；若创建时使用相同密码，就填相同值 |

请将四项都配置完整。GitHub Secrets 的值创建后不会正常显示出来，只需确认名称存在，不要截图或分享具体值。**Netlify 的环境变量与 GitHub Actions secrets 是两套独立配置**，在 Netlify 添加变量不会自动配置 APK 签名。

### 第四步：重新构建并验证

1. 重新运行 **Build Android Shell APK** 工作流。
2. 检查日志中是否成功执行 `Decode keystore (optional)`，并确认后续 APK 构建成功。
3. 下载 `float-shell-release`，用 Android SDK Build Tools 提供的 `apksigner` 验证：
   ```bash
   apksigner verify --verbose --print-certs app-release.apk
   ```
   输出应包含证书信息。若要确认不同版本能互相覆盖更新，还应比较各次 APK 的证书指纹是否一致。

请始终保留原始密钥库和密码。配置完成后，后续 release 构建都使用这把密钥；不要为了更新 APK 随意重新生成密钥。

## 安装与首次设置

1. 把 APK 传到手机（微信文件传输助手 / 网盘 / 数据线均可），点开安装；系统提示「未知来源」时，按系统指引允许该来源安装。
2. 打开 App，正常登录账号。
3. 允许**通知权限**（首次启动会弹）。
4. 保活（收推送的关键，尤其国产 ROM）：
   - 系统设置里把「小手机」加入**电池优化白名单 / 无限制后台**；
   - 允许**自启动**（小米/华为/OPPO/vivo 在各自的手机管家里）；
   - 最近任务里把它**锁定**（下拉卡片 → 锁），避免一键清理杀掉。
5. 通知栏会有一条「小手机 · 后台连接」的常驻小通知——这是长连接保活的代价。不想看到可以长按它 → 把「后台连接」这个通知渠道关掉显示，**不要关「角色消息」渠道**。

设置 → 离线推送里点「测试」：杀掉后台，约 6 秒后应收到系统通知即为连通。

## 数据存放与迁移

壳内网页数据（聊天记录、角色等）存在 App 自己的 WebView 沙箱里，和手机浏览器**不互通**。从浏览器搬家：

- 浏览器里 设置 → 数据管理 → **导出备份**，壳里同一入口**导入**；
- 或两边都登录同一账号，用**云端备份**过渡。

卸载 App 会清掉壳内数据，卸载前记得先导出或云备份。

## 更新模型

- **网页功能更新**：零成本。壳加载的是线上站点，网站重新部署后，壳里会加载线上最新页面。
- **APK 更新**：只有改壳本身（推送逻辑、原生能力）才需要重新构建安装，预期很少。

## 实现速览

```
android-shell/
├── app/src/main/java/app/floatphone/shell/
│   ├── MainActivity.kt   # 全屏 WebView：站内导航/外链/文件选择/下载/返回键
│   ├── PushService.kt    # 前台服务：借 WebView Cookie 取配置 → WS 长连接订阅 shellpush:<userId>
│   └── BootReceiver.kt   # 开机自启
└── ...gradle 工程
```

- 壳的 UA 追加了 ` FloatShell/<版本>`，网页可借 `window.AndroidShell` 或 UA 识别壳环境；桥上有 `getVersion()` / `openAppSettings()` / `requestIgnoreBatteryOptimization()` 三个方法。
- 推送服务首次连上后会向站点注册一条合成订阅（endpoint `shell:<userId>`），用途是让离线消息排期的「账号已订阅」门控放行；服务端对它只做 Realtime 广播，不做 Web Push 投递。
- 壳内设置页的「离线推送」开关由壳自动接管（显示为已开启且不可关），Web Push 在 WebView 里本来就不可用。

## 服务端前提

- Supabase 项目已按 `docs/push-supabase.sql` 配好离线推送（pg_cron + 边缘函数）。
- `supabase/functions/push-generate/index.ts` 需要是包含 shellpush 广播的最新版（改动后需重新部署边缘函数）。
- Realtime 广播用 service key 直接调 HTTP API，无需额外建表或改配置。
