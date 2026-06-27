# MCP 授权状态读取修复 - 验收记录

## 自动化

| 项 | 命令/方式 | 结果 |
|----|-----------|------|
| 编译 | `npm run build` | ✅ |
| 路径解析 | 脚本模拟 `findProjectDir('/Users/kiki/doger/swg/vkk_client_flutter')` | ✅ 命中 `Users-kiki-doger-swg-vkk-client-flutter` |

## 手工（必须）

1. 重启 Cursor Claw（swg profile）。
2. 飞书对 Agent 发 **`/reset`** 重置 SDK 长驻会话（旧会话不会热加载新 MCP）。
3. 再问「你现在可用的 MCP 列表是什么？」—— 应包含 context7、figma、ZEGO、codegraph。

## 范围外

- cursor-claw-admin 自管理 MCP（manage_*）仍走 Claw 守护进程，不在 Composer/SDK 工具列表。
