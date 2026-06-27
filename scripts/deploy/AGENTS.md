# scripts/deploy 编码规范

- 部署脚本使用 **CommonJS**（`.cjs`），与仓库 `"type": "module"` 并存。
- `ROOT` 固定为 `path.join(__dirname, '..', '..')`（相对 `scripts/deploy/` 两级到仓库根）。
- 子进程编排复用 `spawn` + `stdio: 'inherit'` + `cwd: ROOT`；非 Windows 不设 `shell: true`。
- 检查逻辑 inline 于入口文件，**不**新建 `lib/` 或共享 checks 模块（YAGNI）。
- 新增平台入口时各自独立单文件（如 `win.cjs`），勿强行抽象 deploy 框架。
