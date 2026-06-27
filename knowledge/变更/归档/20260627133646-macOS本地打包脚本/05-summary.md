# macOS 本地打包脚本 - 变更总结

## 1、实际变更

| 文件 | 关键改动 |
|------|----------|
| `scripts/deploy/mac.cjs` | **新建** macOS 本地打包统一 CLI：`parseArgs`（`--mode dist\|pack`、`--version`、`--help`/`-h`）、darwin 平台校验、`runChecks`（Node/`node_modules`/electron-builder 必检；CSC/Apple 凭据可选 warn）、`resolveVersion`（默认读 `package.json`，显式 semver 经 `extraMetadata.version` 覆盖且不写回磁盘）、`runPipeline`（`npm run build` → `npx electron-builder --mac [--dir] --publish never`） |
| `scripts/deploy/AGENTS.md` | **新建** deploy 目录编码规范（CommonJS、`ROOT`、spawn 模式、inline 检查、YAGNI 不抽象 lib） |
| `package.json` | `dist:mac` / `pack:mac` 改为 `node scripts/deploy/mac.cjs --mode=dist\|pack` 薄封装；Win/Linux 与其它 scripts 未改 |
| `knowledge/变更/.../04-review.md` | 代码评审通过 |
| `knowledge/变更/.../06-automation-test.md` | CLI 冒烟验收记录（完整 dmg/dir 产出标记手工） |

**未改（显式）**：`electron-builder.yml`、`scripts/bundle-daemon.cjs`、`scripts/after-pack.cjs`、`.github/workflows/build.yml`、Electron 应用代码与 UI。

**统计**：2 个新建实现文件 + 1 个 npm 脚本改动 + 1 个 deploy 规范文件；CLI 约 177 行。

### Archive 版本与 Changelog 待办

本变更为**开发者可见**新能力（macOS 本地统一打包入口），archive 步骤 8–9 须：

- **minor** bump `package.json`：`1.2.2` → **`1.3.0`**
- 新建 `changelog/1.3.0.json`（示例条目：「macOS 本地打包统一入口：检查前置、版本指定、`npm run dist:mac`/`pack:mac` 薄封装」）
- 将 `package.json` 与 `changelog/1.3.0.json` 纳入归档白名单 `manifest.files`

## 2、与设计的差异

有轻微扩展，无结构性偏差（04-review 结论：**通过**）：

1. **CLI 增加 `-h` 别名**：设计 §四 仅列 `--help`；实现 `parseArgs` 同时接受 `-h`。无害，符合常见 CLI 习惯。
2. **新增 `scripts/deploy/AGENTS.md`**：设计 §一·（三）改动汇总未列；实现期补充 deploy 目录编码约束，不扩大功能范围。
3. **设计文档笔误**：§二 写 semver 在 devDependencies；现网在 `dependencies`，实现 `require("semver")` 正确。
4. **完整打包 E2E 待手工**：01 验收 1、02 §八·（二）·1/4 及 06 §4.2 M1–M5 未在本变更会话跑完整 `build` → electron-builder；逻辑与 `electron-builder.yml` 对齐，属 archive 前建议确认，非代码缺陷。

## 3、影响范围

- **涉及模块**：`scripts/deploy/`（新增）、`package.json` mac 相关 scripts（改动）。
- **调用链**：`npm run dist:mac` / `pack:mac` → `scripts/deploy/mac.cjs` → `npm run build` → `npx electron-builder --mac` → `release/`。
- **接口/proto/数据**：无 HTTP、无持久化模型变更。
- **用户可见性**：无 Electron UI 变更；**开发者**获得统一 mac 出包入口、build 前可读校验与 `--version` 覆盖。
- **CI/其它平台**：`.github/workflows/build.yml` 仍直接 `npm run build` + `npx electron-builder --mac --publish never`，不经 deploy；Win/Linux npm scripts 不变。

### 3.1 Ponytail 技术债

diff 中无 `ponytail:` 注释。04-review §7 结论：实现符合 §二 最小方案（单文件 inline、无 lib/、无新依赖）。**Lean already. Ship.**

| 位置 | 注释摘要 | 升级路径 |
|------|----------|----------|
| — | 无 | — |

**非 Ponytail 遗留**（06 §4.2 手工清单）：完整 dmg/dir 产出、Node&lt;18 环境验证、非 darwin 平台失败、整目录 `node_modules` 缺失时 require 堆栈（未走到 `runChecks` 中文提示）— archive 前可选确认，不阻断归档。

## 4、知识库影响清单

继承 `02-design.md` §十，按实际实现修正：

- [ ] `knowledge/工程平台/Electron桌面应用/05-构建与打包.md` — **新建**十段式：deploy 入口、`runChecks` 项、`--mode`/`--version`、npm 薄封装、与 CI 隔离、产出 `release/`
- [ ] `knowledge/工程平台/Electron桌面应用/00-README.md` — 文件清单与阅读路径增加 `05-构建与打包.md` 入口
- [ ] 根 `README.md` — 「打包」小节补充 `node scripts/deploy/mac.cjs` 直接调用与 `--version` 示例（现仍仅列 `npm run dist:mac`）
- [x] `knowledge/工程平台/Electron桌面应用/01-概览.md` — 可选在依赖/文档入口引用 05；archive 若 05 已覆盖则仅链 00-README
- [x] `knowledge/业务域/**` — 无用户可见行为变更，无需更新
- [x] `knowledge/工程平台/Daemon守护进程/**` — 与 Daemon 部署无关
- [x] `.github/workflows/build.yml` 相关知识 — 本期不改 CI
- [x] `knowledge/知识索引.md` — 总入口仍指向工程平台 README；分区 README 更新后无需改总索引（无新增领域/分区）
