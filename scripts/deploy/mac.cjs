/**
 * macOS 本地打包统一入口。
 *
 * 用法:
 *   node scripts/deploy/mac.cjs [--mode=dist|pack] [--version=<semver>] [--help]
 *   npm run dist:mac
 *   npm run pack:mac
 */

const { spawn } = require("child_process")
const fs = require("fs")
const path = require("path")
const semver = require("semver")

const ROOT = path.join(__dirname, "..", "..")

function parseArgs(argv) {
  const args = argv.slice(2)
  let mode = "dist"
  let version
  let help = false

  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      help = true
    } else if (arg.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length)
      if (value !== "dist" && value !== "pack") {
        console.error(`错误: 无效的 --mode 值 "${value}"，仅支持 dist 或 pack`)
        process.exit(1)
      }
      mode = value
    } else if (arg.startsWith("--version=")) {
      version = arg.slice("--version=".length)
      if (!version) {
        console.error("错误: --version 不能为空")
        process.exit(1)
      }
    } else {
      console.error(`错误: 未知参数 "${arg}"`)
      console.error("使用 --help 查看用法")
      process.exit(1)
    }
  }

  return { mode, version, help }
}

function printHelp() {
  console.log(
    `
macOS 本地打包脚本

用法:
  node scripts/deploy/mac.cjs [选项]

选项:
  --mode=dist|pack    打包模式：dist 产出 dmg（默认）；pack 产出目录包
  --version=<semver>  覆盖 package.json 中的版本号（不写回磁盘）
  --help, -h          显示此帮助

示例:
  node scripts/deploy/mac.cjs
  node scripts/deploy/mac.cjs --mode=pack
  node scripts/deploy/mac.cjs --version=1.2.3-test
  npm run dist:mac
  npm run pack:mac
`.trim(),
  )
}

function runChecks() {
  const pkgPath = path.join(ROOT, "package.json")
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
  const requiredNode = pkg.engines?.node || ">=18.0.0"

  if (!semver.satisfies(process.version, requiredNode)) {
    console.error(`错误: Node 版本不满足要求（当前 ${process.version}，需要 ${requiredNode}）`)
    console.error("请升级 Node 至 18 或更高版本")
    process.exit(1)
  }

  const nodeModulesDir = path.join(ROOT, "node_modules")
  if (!fs.existsSync(nodeModulesDir)) {
    console.error("错误: 未找到 node_modules 目录")
    console.error("请在仓库根目录运行: npm install")
    process.exit(1)
  }

  const ebBin = path.join(nodeModulesDir, ".bin", "electron-builder")
  if (!fs.existsSync(ebBin)) {
    console.error("错误: 未找到 electron-builder（node_modules/.bin/electron-builder）")
    console.error("请运行: npm install")
    process.exit(1)
  }

  const signVars = ["CSC_LINK", "CSC_NAME", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD"]
  const configured = signVars.filter((v) => process.env[v])
  if (configured.length === 0) {
    console.warn(
      "提示: 未配置代码签名/公证环境变量（CSC_LINK、CSC_NAME、APPLE_ID、APPLE_APP_SPECIFIC_PASSWORD）。\n" +
        "当前将走无签名本地打包路径；首次打开若被 Gatekeeper 拦截，请右键应用选择「打开」。",
    )
  }
}

function resolveVersion(explicitVersion) {
  if (explicitVersion) {
    const valid = semver.valid(explicitVersion)
    if (!valid) {
      console.error(`错误: 无效的 semver 版本 "${explicitVersion}"`)
      process.exit(1)
    }
    return valid
  }

  const pkgPath = path.join(ROOT, "package.json")
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
  return pkg.version
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      stdio: "inherit",
      env: process.env,
    })
    child.on("error", reject)
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`))))
  })
}

async function runPipeline(mode, resolvedVersion) {
  console.log("→ npm run build")
  await run("npm", ["run", "build"])

  const ebArgs = [
    "electron-builder",
    "--mac",
    "--publish",
    "never",
    `--config.extraMetadata.version=${resolvedVersion}`,
  ]
  if (mode === "pack") {
    ebArgs.push("--dir")
  }

  console.log(`→ npx ${ebArgs.join(" ")}`)
  await run("npx", ebArgs)
}

async function main() {
  if (process.platform !== "darwin") {
    console.error("错误: 此脚本仅支持 macOS")
    process.exit(1)
  }

  const { mode, version, help } = parseArgs(process.argv)

  if (help) {
    printHelp()
    return
  }

  runChecks()
  const resolvedVersion = resolveVersion(version)
  console.log(`使用版本: ${resolvedVersion}`)

  await runPipeline(mode, resolvedVersion)
}

main().catch((e) => {
  console.error(e.message || e)
  process.exit(1)
})
