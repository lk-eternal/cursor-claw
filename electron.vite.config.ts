import { resolve } from "node:path"
import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          "electron-store",
          "electron-updater",
          "node-cron",
          "cron-parser",
          "semver",
        ],
      }),
    ],
    build: {
      rollupOptions: {
        input: {
          index: resolve("electron/main.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve("electron/preload.ts"),
        },
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    root: "src/renderer",
    plugins: [react(), tailwindcss()],
    server: {
      // 显式绑定 IPv4：Node 17+ 解析 localhost 可能优先 ::1，
      // 导致 dev server 只监听 IPv6 而 Electron 按 127.0.0.1 连接失败（白屏）
      host: "127.0.0.1",
    },
    build: {
      rollupOptions: {
        input: resolve("src/renderer/index.html"),
      },
    },
  },
})
