# macOS 本地打包脚本 - 验收记录

> **变更 ID**：`20260627133646-macOS本地打包脚本`
> **阶段**：`/kb-test`（CLI 冒烟 + 静态对照；完整 dmg/dir 产出归手工）
> **评审结论引用**：`04-review.md` 通过；§7 遗留完整打包 E2E 待本机确认

## 1、测试策略与范围

| 维度 | 说明 |
|------|------|
| **层级** | **CLI 冒烟**（help/参数/必检前置）+ **npm 薄封装转发** + **04-review 静态**；完整 `npm run build` → electron-builder 链路标记手工 |
| **目标** | 覆盖 `01-proposal` 验收 2/3/4/5/6、`03-tasks` T1–T5、`02-design` §八·（二）工程补充项 |
| **通过口径** | 冒烟项 exit 码与中文提示符合 02/03；必检在 build 前失败；npm 与直接 CLI 同入口；CI/workflow 未引用 deploy |
| **与 review 分工** | 04 负责实现与规范；本文负责验收追溯与执行证据 |

## 2、局限与未自动化原因

| 未自动化项 | 原因 |
|------------|------|
| 01 验收 1：完整 dmg（x64+arm64）产出 | `npm run build` + electron-builder 耗时长（数分钟～十余分钟）；副作用写入 `release/`、`dist/` |
| 02 §八·（二）·1/4：dmg 形态与 `pack:mac` dir 产出 | 同上；须本机 macOS 人工核对 `release/` 产物 |
| T2 / §八·（二）·2：Node &lt;18 build 前失败 | 本机 Node v26；切换 nvm 旧版本属环境操作，未在本会话执行 |
| T2：整目录 `node_modules` 缺失 | 移除后脚本在 `require('semver')` 即失败（Node 堆栈），未走到 `runChecks` 中文提示；见 §7 备注 |
| 01 验收 4 延伸：dmg/Info.plist 内展示版本 | 依赖完整打包后解析产物 |
| 非 darwin 平台失败 | 本机为 macOS，未模拟 `process.platform !== 'darwin'` |
| `auto_test/` 脚本 | 本期未新增；CLI 可直接复现 |

## 3、验收追溯表

| 来源 | 验收要点 | 验证方式 | 证据类型 | 状态 |
|------|----------|----------|----------|------|
| **T1** | `--help` exit 0；mode 解析；非法 mode 失败 | CLI `--help`、`-h`、`--mode=foo` | 终端 exit/摘要 | ✅ 通过 |
| **T1** | 非 darwin 立即失败 | 未模拟 | — | ⏳ 待手工/他平台 |
| **T2** | Node/node_modules/eb 必检；无签名 warn 可继续 | 缺 eb 二进制；无 CSC 时 `--version=invalid` | CLI 摘要 | ✅ 部分（eb ✅；整目录 nm ⚠️） |
| **T2** | Node &lt;18 build 前失败 | nvm 切换 | 环境 | ⏳ 待手工 |
| **T3** | 默认/指定版本；非法 semver；不写回 package.json | `--version=not-a-version`；04 静态 | CLI / 代码 | ✅ CLI+静态 |
| **T4** | build→eb 顺序；pack `--dir`；extraMetadata.version | 04 静态 `runPipeline` | 代码复核 | ✅ 静态 |
| **T4** | 完整 dmg / pack dir 产出 | 本机 `dist:mac` / `pack:mac` | 产物 | ⏳ 待手工 |
| **T5** | npm 薄封装；CI 不变；Win 不变 | `npm run * -- --help`；grep workflow/package.json | CLI / 静态 | ✅ 通过 |
| **01·1** | 一键 dmg 至 `release/` | 完整打包 | 产物 | ⏳ 待手工 |
| **01·2** | 必检失败 build 前可读说明 | eb 缺失、非法 mode/version | CLI | ✅ 通过 |
| **01·3** | 默认版本 = package.json | 04 静态；pkg 1.2.2 | 代码 | ✅ 静态 |
| **01·4** | `--version` 覆盖合法 semver | `1.2.3-test` 逻辑在 04；非法已测 | CLI / 04 | ✅ 部分 |
| **01·5** | npm 与 deploy 一致 | `dist:mac`/`pack:mac -- --help` | CLI | ✅ 通过 |
| **01·6** | 无 Win/Linux deploy | 仅 `scripts/deploy/mac.cjs` | 目录扫描 | ✅ 通过 |
| **01·7** | 无 UI 变更 | 04 静态 | 代码 | ✅ 静态 |
| **§八·(二)·1** | dmg 与改前一致 | 完整打包对比 | 产物 | ⏳ 待手工 |
| **§八·(二)·2** | Node&lt;18 可读失败 | nvm | 环境 | ⏳ 待手工 |
| **§八·(二)·3** | 无 CSC warn 且可继续 | 无签名 warn 已见 | CLI stderr | ✅ 通过 |
| **§八·(二)·4** | pack 产出 dir | 完整 pack | 产物 | ⏳ 待手工 |
| **§八·(二)·5** | CI 未引用 deploy | grep `build.yml` | 静态 | ✅ 通过 |

## 4、场景摘要

### 4.1 CLI 冒烟清单（已执行）

| 场景 ID | 前置 | 命令摘要 | 期望 | 关联 |
|---------|------|----------|------|------|
| **C1 help** | macOS；仓库根 | `node scripts/deploy/mac.cjs --help` | exit 0；用法含 mode/version | T1 |
| **C2 别名** | 同上 | `node scripts/deploy/mac.cjs -h` | 同 C1 | T1 |
| **C3 非法 mode** | 同上 | `--mode=foo` | exit 1；中文「仅支持 dist 或 pack」；无 build | T1、01·2 |
| **C4 未知参数** | 同上 | `--unknown` | exit 1；提示 `--help` | T1 |
| **C5 非法 semver** | 同上；无 CSC | `--version=not-a-version` | 先 warn 无签名；再 semver 错误；无 build | T2、T3、01·2 |
| **C6 缺 electron-builder** | 临时移走 `.bin/electron-builder` | `--version=1.2.3-test` | exit 1；提示 `npm install`；无 build | T2、01·2 |
| **C7 npm dist** | 同上 | `npm run dist:mac -- --help` | 调用 `mac.cjs --mode=dist` | T5、01·5 |
| **C8 npm pack** | 同上 | `npm run pack:mac -- --help` | 调用 `mac.cjs --mode=pack` | T5、01·5 |

### 4.2 手工清单（archive 前建议）

| 场景 ID | 前置 | 步骤摘要 | 期望 | 关联 |
|---------|------|----------|------|------|
| **M1 完整 dmg** | Node≥18；`npm install` 完成 | `node scripts/deploy/mac.cjs` 或 `npm run dist:mac` | `release/` 下 dmg；含 x64+arm64 | 01·1、T4、§八·(二)·1 |
| **M2 pack dir** | 同上 | `npm run pack:mac` | `release/` 下目录包非 dmg | T4、§八·(二)·4 |
| **M3 指定版本产物** | M1 完成 | `--version=9.9.9-test` 打包后查 Info.plist | 展示版本为指定值 | 01·4、T3 |
| **M4 Node 过低** | nvm 切 Node 16 | 任意非 help 命令 | build 前失败；中文升级提示 | T2、§八·(二)·2 |
| **M5 非 macOS** | Linux/Win CI 或 VM | 运行脚本 | exit 1；「仅支持 macOS」 | T1、01·6 |

签名相关环境变量（仅名称）：`CSC_LINK`、`CSC_NAME`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD` — 未配置时走无签名路径（C5 已见 warn）。

## 5、脚本位置与环境

| 项 | 说明 |
|----|------|
| **入口** | `scripts/deploy/mac.cjs` |
| **npm 封装** | `package.json` → `dist:mac`、`pack:mac` |
| **脚本目录** | 本期无 `auto_test/` 新增 |
| **运行依赖** | macOS（darwin）；Node ≥ `engines.node`（现网 `>=18.0.0`）；仓库根 `node_modules` 含 `electron-builder` |
| **产出目录** | `release/`（`electron-builder.yml` `directories.output`） |
| **CI 对照** | `.github/workflows/build.yml` 仍为 `npm run build` + `npx electron-builder --mac --publish never`，**不**经 deploy |

## 6、输出与记录规范

- 会话与本文**禁止**粘贴完整终端日志、含 token/证书内容。
- 执行记录仅用 §7 表格：日期、环境、命令/场景 ID、结果、备注（一词结论）。
- 失败时区分：**脚本/参数问题** vs **构建链/签名/环境问题**（记备注列）。

## 7、执行记录

| 日期 | 环境 | 命令/场景 | 结果 | 备注 |
|------|------|-----------|------|------|
| 2026-06-27 | macOS；Node v26.3.1；pkg 1.2.2 | 04-review 静态 + workflow grep | 通过 | 无 deploy 引用 |
| 2026-06-27 | 同上 | C1–C2 help / -h | 通过 | exit 0 |
| 2026-06-27 | 同上 | C3–C4 非法 mode/未知参数 | 通过 | build 前失败 |
| 2026-06-27 | 同上；无 CSC | C5 非法 semver | 通过 | 含无签名 warn |
| 2026-06-27 | 同上 | C6 缺 electron-builder | 通过 | 中文 npm install |
| 2026-06-27 | 同上 | C7–C8 npm --help 转发 | 通过 | mode=dist/pack |
| 2026-06-27 | 同上 | 整目录 node_modules 缺失探测 | 部分 | require semver 堆栈 |
| 2026-06-27 | — | M1–M5 完整打包/跨平台 | 待执行 | archive 前建议 |
