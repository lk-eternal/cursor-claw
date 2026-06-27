/**
 * macOS 本地打包统一入口。
 *
 * 用法:
 *   node scripts/deploy/mac.cjs [--mode=dist|pack] [--version=<semver>] [--no-install] [--help]
 *   npm run dist:mac
 *   npm run pack:mac
 */

const { spawn, execFileSync } = require("child_process")
const fs = require("fs")
const os = require("os")
const path = require("path")
const semver = require("semver")

const APP_NAME = "Cursor Claw.app"
const INSTALL_DEST = path.join("/Applications", APP_NAME)
const DEFAULT_PROFILE = "swg"

const ROOT = path.join(__dirname, "..", "..")

function parseArgs(argv) {
  const args = argv.slice(2)
  let mode = "dist"
  let version
  let help = false
  let install = true
  let profile = DEFAULT_PROFILE

  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      help = true
    } else if (arg === "--no-install") {
      install = false
    } else if (arg === "--no-profile") {
      profile = ""
    } else if (arg.startsWith("--profile=")) {
      profile = arg.slice("--profile=".length)
      if (!profile) {
        console.error("错误: --profile 不能为空（可用 --no-profile 启动默认数据目录）")
        process.exit(1)
      }
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

  return { mode, version, help, install, profile }
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
  --no-install        仅打包，不安装到 /Applications、不自动启动
  --profile=<name>    启动时传入 --profile=（默认 swg）
  --no-profile        启动时不传 profile，使用默认 userData
  --help, -h          显示此帮助

默认行为:
  打包成功后自动安装到 /Applications/Cursor Claw.app，去除隔离属性并以 profile=swg 启动。

示例:
  node scripts/deploy/mac.cjs
  node scripts/deploy/mac.cjs --profile=dev
  node scripts/deploy/mac.cjs --no-profile
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

function releaseAppDir() {
  return process.arch === "arm64" ? "mac-arm64" : "mac"
}

function resolveDmgPath(resolvedVersion) {
  const releaseDir = path.join(ROOT, "release")
  const candidates =
    process.arch === "arm64"
      ? [`Cursor Claw-${resolvedVersion}-arm64.dmg`, `Cursor Claw-${resolvedVersion}.dmg`]
      : [`Cursor Claw-${resolvedVersion}.dmg`, `Cursor Claw-${resolvedVersion}-arm64.dmg`]

  for (const name of candidates) {
    const dmgPath = path.join(releaseDir, name)
    if (fs.existsSync(dmgPath)) return dmgPath
  }

  console.error("错误: 未在 release/ 找到 dmg 安装包")
  console.error(`已尝试: ${candidates.join(", ")}`)
  process.exit(1)
}

function launchApp(profile) {
  const openArgs = ["-n", "-a", "Cursor Claw"]
  if (profile) {
    console.log(`→ 启动应用（--profile=${profile}）`)
    openArgs.push("--args", `--profile=${profile}`)
  } else {
    console.log("→ 启动应用（无 profile）")
  }
  execFileSync("open", openArgs, { stdio: "inherit" })
}

function installToApplications(appSrc, profile) {
  console.log(`→ 安装到 ${INSTALL_DEST}`)
  if (fs.existsSync(INSTALL_DEST)) {
    fs.rmSync(INSTALL_DEST, { recursive: true, force: true })
  }
  execFileSync("cp", ["-R", appSrc, "/Applications/"], { stdio: "inherit" })
  execFileSync("xattr", ["-cr", INSTALL_DEST], { stdio: "inherit" })
  console.log(`✓ 已安装 ${INSTALL_DEST}`)
  launchApp(profile)
}

function installFromPack(profile) {
  const appPath = path.join(ROOT, "release", releaseAppDir(), APP_NAME)
  if (!fs.existsSync(appPath)) {
    console.error(`错误: 未找到 ${appPath}`)
    process.exit(1)
  }
  installToApplications(appPath, profile)
}

function installFromDist(resolvedVersion, profile) {
  const dmgPath = resolveDmgPath(resolvedVersion)
  const mountPoint = path.join(os.tmpdir(), `cursor-claw-install-${process.pid}`)
  fs.mkdirSync(mountPoint, { recursive: true })

  try {
    console.log(`→ 挂载 ${path.basename(dmgPath)}`)
    execFileSync("hdiutil", ["attach", dmgPath, "-nobrowse", "-mountpoint", mountPoint], {
      stdio: "inherit",
    })
    const appPath = path.join(mountPoint, APP_NAME)
    if (!fs.existsSync(appPath)) {
      console.error(`错误: DMG 内未找到 ${APP_NAME}`)
      process.exit(1)
    }
    installToApplications(appPath, profile)
  } finally {
    try {
      execFileSync("hdiutil", ["detach", mountPoint, "-quiet"], { stdio: "inherit" })
    } catch {
      // 已卸载或挂载失败时忽略
    }
    fs.rmSync(mountPoint, { recursive: true, force: true })
  }
}

function runInstall(mode, resolvedVersion, profile) {
  if (mode === "pack") {
    installFromPack(profile)
  } else {
    installFromDist(resolvedVersion, profile)
  }
}

async function main() {
  if (process.platform !== "darwin") {
    console.error("错误: 此脚本仅支持 macOS")
    process.exit(1)
  }

  const { mode, version, help, install, profile } = parseArgs(process.argv)

  if (help) {
    printHelp()
    return
  }

  runChecks()
  const resolvedVersion = resolveVersion(version)
  console.log(`使用版本: ${resolvedVersion}`)
  if (install) {
    console.log(`启动 profile: ${profile || "（默认 userData）"}`)
  }

  await runPipeline(mode, resolvedVersion)

  if (install) {
    runInstall(mode, resolvedVersion, profile)
  } else {
    console.log("已跳过安装（--no-install）")
  }
}

main().catch((e) => {
  console.error(e.message || e)
  process.exit(1)
})
