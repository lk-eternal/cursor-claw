# macOS 本地打包脚本 - 任务分解

> **来源**：`/kb-plan`（基于 `01-proposal.md`、`02-design.md`）

## 一、执行计划

### （一）依赖图

```
T1 ──→ T2 ──→ T3 ──→ T4 ──→ T5
```

**文件冲突说明**：T1～T4 均修改/新建 `scripts/deploy/mac.cjs`，须严格按轮次串行，不得并行。

### （二）分组调度

- **第一轮**：T1（deploy 入口骨架与 CLI）
- **第二轮**：T2（环境与依赖检查）
- **第三轮**：T3（版本解析）
- **第四轮**：T4（构建与 electron-builder 编排）
- **第五轮**：T5（npm scripts 薄封装）

## 二、任务清单

## T1: deploy 入口骨架与 CLI 解析

### 背景

实现流程 S1～S3：在 `scripts/deploy/` 新建统一 macOS 本地打包入口，完成 CLI 参数解析、平台校验与 `--help` 输出。这是后续检查、版本与构建编排的基础；非 macOS 须立即中止，满足 01 范围合规（验收 6）。

### 上下文文件

- CodeGraph: `dist:mac` `pack:mac` `scripts` — 定位现网 npm 打包入口与脚本目录
- 必读: `package.json` — 当前 `dist:mac`/`pack:mac` 定义（L34–36）、`engines.node`（L75–77）
- 必读: `knowledge/变更/进行中/20260627133646-macOS本地打包脚本/01-proposal.md` — F1.1、验收 1/6
- 参考: `scripts/dev-fresh-setup.cjs` — `ROOT` 路径、`main().catch` + `process.exit(1)` 模式

### 实现范围

- 新建: `scripts/deploy/mac.cjs` — 单文件 CLI 入口，包含：
  - `ROOT = path.join(__dirname, '..', '..')`（仓库根）
  - `parseArgs(argv)`：解析 `--mode=dist|pack`（默认 `dist`）、`--version=<semver>`、`--help`
  - `printHelp()`：打印用法（含 mode、version 示例）
  - `main()` 骨架：非 `process.platform === 'darwin'` 时打印中文说明并 `process.exit(1)`；`--help` 时打印后 `exit(0)`；其余分支暂留 TODO 占位或空实现
  - 模块末尾 `main().catch(...)` 统一错误退出
- 不修改: `package.json`、`electron-builder.yml`、CI workflow

### 接口契约

- `node scripts/deploy/mac.cjs [--mode=dist|pack] [--version=<semver>] [--help]` — CLI 入口
- 退出码：`0` 成功；`1` 平台不符、参数错误或未捕获异常
- `parseArgs()` 返回 `{ mode: 'dist'|'pack', version: string|undefined, help: boolean }` — 供 T2～T4 复用

### 验收标准

- [ ] 在 macOS 上 `node scripts/deploy/mac.cjs --help` 打印用法并 exit 0
- [ ] `--mode=pack` / 缺省 `--mode` 解析为 `pack` / `dist`
- [ ] 在非 darwin 平台（或模拟 `process.platform !== 'darwin'`）立即失败，中文提示「仅支持 macOS」，不进入构建
- [ ] 非法 `--mode=foo` 失败并给出可读说明
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: 无
- 后续任务: T2

---

## T2: 环境与依赖检查 runChecks

### 背景

实现流程 S4 与 01 F2.1～F2.3：在真正执行 `npm run build` 前 inline 完成必检，失败立即 `process.exit(1)` 并输出中文可操作说明；签名/公证相关环境变量仅作就绪提示，未配置时明确「无签名/本地打包」且允许继续（对齐 02 §八·（二）第 3 项）。

### 上下文文件

- CodeGraph: `engines` `electron-builder` — Node 下限与打包 CLI 位置
- 必读: `scripts/deploy/mac.cjs`（T1 产出）— 在 `main()` 中调用检查的位置
- 必读: `package.json` — `engines.node`（`>=18.0.0`）、`devDependencies.semver`（已有，T3 复用，本任务不引入新包）
- 参考: `electron-builder.yml` — mac target dmg x64+arm64（确认检查项不重复配置职责）
- 参考: `.github/workflows/build.yml` L54 — `npx electron-builder --mac --publish never`（对照本地 publish 行为，本任务不改 CI）

### 实现范围

- 修改: `scripts/deploy/mac.cjs` — 新增 `runChecks()` 并在 `main()` 中于 build 前调用：
  - **必检（失败即 exit 1）**：
    - Node 版本 ≥ `package.json` `engines.node` 下限（现网 18.0.0）；比较可用 `process.version` 与 `semver.coerce`/`semver.gte`（复用项目 `semver`）
    - 仓库根存在 `node_modules/` 目录
    - 存在 `node_modules/.bin/electron-builder`（或等效可执行）
  - **可选提示（不阻断）**：
    - 检测 `CSC_LINK`、`CSC_NAME`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`；均未设置时 `console.warn` 说明当前为无签名本地打包路径及 Gatekeeper 右键打开提示
  - 每项失败/警告均输出中文说明与建议操作（如「请运行 npm install」「请升级 Node 至 18+」）
- 不新建: `scripts/deploy/lib/` 或独立 checks 模块（02 §二 YAGNI）

### 接口契约

- `function runChecks(): void` — 通过则返回；必检失败则打印说明并 `process.exit(1)`，不抛出让上层 catch 的异常

### 验收标准

- [ ] 满足 01 验收 2：模拟 Node 低于 18（如临时改 PATH 或使用 `NODE_OPTIONS` 不可行时，可文档化用 `nvm` 切换验证），脚本在 build 前失败，信息可读、无长时间构建
- [ ] 删除或重命名 `node_modules` 后运行，build 前失败并提示 `npm install`
- [ ] 未配置 CSC/Apple 凭据时，输出含「无签名/本地打包」说明且流程可继续进入后续步骤（02 §八·（二）第 3 项）
- [ ] 全部必检通过后 `runChecks()` 正常返回，不 exit
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T1
- 后续任务: T3

---

## T3: 版本解析 resolveVersion

### 背景

实现流程 S5 与 01 F3.1～F3.3：确定本轮打包使用的 semver。未传 `--version` 时读 `package.json` 的 `version`；传入时用 `semver.valid()` 校验。版本仅通过 electron-builder `extraMetadata.version` 覆盖，不写回磁盘上的 `package.json`（02 §四、§五）。

### 上下文文件

- 必读: `scripts/deploy/mac.cjs`（T1+T2 产出）— 接入 `parseArgs().version`
- 必读: `package.json` — 当前 `version` 字段
- 参考: 02-design §四 CLI 表 — `--version` 与默认互斥语义

### 实现范围

- 修改: `scripts/deploy/mac.cjs` — 新增 `resolveVersion(explicitVersion?: string): string`：
  - 无 `explicitVersion`：读取 `ROOT/package.json` 的 `version`
  - 有 `explicitVersion`：`semver.valid()` 校验，非法则打印中文错误并 `process.exit(1)`
  - 返回非空 semver 字符串，供 T4 传入 `--config.extraMetadata.version=`
- 在 `main()` 中调用并将结果存为 `resolvedVersion`（日志可打印「使用版本: x.y.z」）

### 接口契约

- `function resolveVersion(explicitVersion?: string): string` — 返回本轮打包版本
- 与 CLI 互斥：`--version` 有则覆盖 package.json，无则用 package.json；同一轮不存在双来源

### 验收标准

- [ ] 01 验收 3：未传 `--version` 时，`resolveVersion` 返回值与 `package.json` `version` 一致
- [ ] 01 验收 4：传 `--version=1.2.3-test` 等合法 semver 时返回该值；传 `not-a-version` 失败并 exit 1
- [ ] 运行过程中不修改 `package.json` 文件内容（可前后 diff 验证）
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T2
- 后续任务: T4

---

## T4: 构建与 electron-builder 编排

### 背景

实现流程 S6～S7 与 01 验收 1/7：在检查与版本确定后，顺序 spawn `npm run build` 与 `npx electron-builder --mac`，产出与现网一致的 dmg（dist）或目录包（pack）。配置仍读 `electron-builder.yml`，不改 afterPack 等既有钩子。

### 上下文文件

- 必读: `scripts/deploy/mac.cjs`（T1～T3 产出）— 接入编排
- 必读: `package.json` — `scripts.build` 链路（clean → build:mcp → build:bundle → electron-vite build）
- 必读: `electron-builder.yml` — `directories.output: release`、`mac.target` dmg x64+arm64
- 参考: `scripts/dev-fresh-setup.cjs` — `run(cmd, args)`：`spawn` + `stdio: 'inherit'` + `cwd: ROOT` + 非零 exit 拒绝
- 参考: `.github/workflows/build.yml` L54 — `--publish never`

### 实现范围

- 修改: `scripts/deploy/mac.cjs` — 新增 `run(cmd, args)`（或等价）与 `async function runPipeline(mode, resolvedVersion)`：
  1. `await run('npm', ['run', 'build'])`（cwd = ROOT）
  2. 组装 `npx electron-builder --mac [--dir] --publish never --config.extraMetadata.version=<resolvedVersion>`
     - `mode === 'pack'` 时附加 `--dir`；`dist` 时不加
  3. stdio inherit；子进程非零 exit 时 exit 1
- 在 `main()` 中：`runChecks()` → `resolveVersion()` → `runPipeline()`
- 不修改: `electron-builder.yml`、`scripts/bundle-daemon.cjs`、`scripts/after-pack.cjs`、`.github/workflows/build.yml`

### 接口契约

- `async function runPipeline(mode: 'dist'|'pack', resolvedVersion: string): Promise<void>` — 完成 build + electron-builder
- electron-builder CLI 参数：`--mac`、`--publish never`、`--config.extraMetadata.version=<ver>`、`pack` 模式加 `--dir`

### 验收标准

- [ ] 01 验收 1：macOS 环境满足前提下，`node scripts/deploy/mac.cjs`（默认 dist）完成打包，产出位于 `release/` 的 dmg，含 x64 与 arm64（与现网 `electron-builder.yml` 一致）
- [ ] 02 §八·（二）第 1 项：`node scripts/deploy/mac.cjs` 产出 dmg 形态与改 npm 前 `npm run dist:mac` 一致（同名形态、同输出目录）
- [ ] 02 §八·（二）第 4 项：`--mode=pack` 产出 `--dir` 目录结构而非 dmg
- [ ] 01 验收 4 延伸：指定 `--version` 后，检查 dmg/应用 Info.plist 或包内展示版本与指定值一致（若与 package.json 不同，以 extraMetadata 为准）
- [ ] build 失败时脚本 exit 1，不继续 electron-builder
- [ ] 01 验收 7：无 Electron 应用 UI 或安装体验变更
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T3
- 后续任务: T5

---

## T5: npm scripts 薄封装

### 背景

实现流程 S0 与 01 F4.1～F4.3、验收 5：将 `package.json` 中 `dist:mac`、`pack:mac` 改为调用 deploy 统一入口，消除「npm 内嵌 build && electron-builder」与 deploy 脚本双路径漂移；CI 仍不引用 deploy 脚本（02 §八·（二）第 5 项）。

### 上下文文件

- 必读: `package.json` — 当前 `dist:mac`、`pack:mac`（L34–36）
- 必读: `scripts/deploy/mac.cjs`（T4 完整实现）— 确认 CLI 契约
- 参考: 02-design §四 npm 薄封装拟定 JSON

### 实现范围

- 修改: `package.json` `scripts` 段：
  - `"dist:mac": "node scripts/deploy/mac.cjs --mode=dist"`
  - `"pack:mac": "node scripts/deploy/mac.cjs --mode=pack"`
- 删除/替换: 原 `"npm run build && electron-builder --mac ..."` 内联逻辑（build 改由 deploy 内 spawn，避免重复 build 仅当 npm 不再前置 build）
- 不修改: `dist:win`、`dist:linux`、`build` 及其他 scripts；不修改 `.github/workflows/build.yml`

### 接口契约

- `npm run dist:mac` → 等价 `node scripts/deploy/mac.cjs --mode=dist`
- `npm run pack:mac` → 等价 `node scripts/deploy/mac.cjs --mode=pack`

### 验收标准

- [ ] 01 验收 5：`npm run dist:mac` 与直接 `node scripts/deploy/mac.cjs --mode=dist` 在检查项、版本行为、产出物上一致
- [ ] 01 验收 5：`npm run pack:mac` 与 `--mode=pack` 一致
- [ ] 02 §八·（二）第 5 项：`.github/workflows/build.yml` 无变更，PR diff 不包含 workflow 修改
- [ ] 01 验收 6：未新增 Windows/Linux deploy 入口；`dist:win` 等保持原样
- [ ] 无 `02`/`03` 未要求的抽象层、trait/mixin 中间层或未批准的新依赖（Ponytail 口径）

### 依赖

- 前置任务: T4
- 后续任务: 无（README/知识库补充归 `/kb-archive`）
