import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, shell, Tray } from "electron"
import { spawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"
import YAML from "yaml"
import { InstanceManager } from "./instance-manager.js"
import { MarketManager } from "./market-manager.js"
import { RuntimeManager } from "./runtime-manager.js"
import { RedisManager } from "./redis-manager.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isWindows = process.platform === "win32"
const defaultYunzaiPath = "D:\\Bot\\Bot\\Yunzai"
const frameworkRepository = "https://git.trss.me/Yunzai"
const logLimit = 3000

app.commandLine.appendSwitch("lang", "zh-CN")
app.setName("DYunzai")
nativeTheme.themeSource = "system"

let mainWindow
let tray
let yunzaiProcess
let maintenanceProcess
let stopping = false
let restartTimer
let startedAt = 0
let logs = []
let runtime
let instance
let market
let redis
let settings
let processGeneration = 0
let crashHistory = []
let restartSuspended = false

function isYunzaiDirectory(directory) {
  return Boolean(
    directory &&
      fs.existsSync(path.join(directory, "app.js")) &&
      fs.existsSync(path.join(directory, "package.json")),
  )
}

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json")
}

function defaultFrameworkInstallPath() {
  const applicationDirectory = app.isPackaged ? path.dirname(process.execPath) : __dirname
  return path.join(applicationDirectory, "Bot", "Yunzai")
}

function frameworkInstallPath() {
  return path.resolve(settings?.frameworkPath || defaultFrameworkInstallPath())
}

function defaultSettings() {
  const managedPath = defaultFrameworkInstallPath()
  return {
    frameworkPath: managedPath,
    yunzaiPath: isYunzaiDirectory(managedPath)
      ? managedPath
      : isYunzaiDirectory(defaultYunzaiPath)
        ? defaultYunzaiPath
        : path.resolve(__dirname, ".."),
    nodePath: "auto",
    autoStart: false,
    autoRestart: true,
    minimizeToTray: true,
    openAtLogin: false,
    themeColor: "#6d8cff",
    opacity: 0.92,
    glassEnabled: false,
    animations: true,
  }
}

function readSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath(), "utf8"))
    if (saved.nodePath === "node") saved.nodePath = "auto"
    const merged = { ...defaultSettings(), ...saved }
    merged.frameworkPath = path.resolve(merged.frameworkPath || defaultFrameworkInstallPath())
    merged.opacity = Math.min(1, Math.max(0.7, Number(merged.opacity) || 0.92))
    if (!Object.hasOwn(saved, "glassEnabled")) merged.glassEnabled = false
    delete merged.backgroundMaterial
    return merged
  } catch {
    return defaultSettings()
  }
}

function writeSettings(value) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
  fs.writeFileSync(settingsPath(), JSON.stringify(value, null, 2), "utf8")
}

function updateWindowAppearance(value = settings) {
  if (!mainWindow) return
  const dark = nativeTheme.shouldUseDarkColors
  mainWindow.setBackgroundColor(dark ? "#0b1020" : "#f2f5f9")
  const opacity = Math.min(1, Math.max(0.7, Number(value.opacity) || 0.92))
  mainWindow.setOpacity(value.glassEnabled ? opacity : 1)
  if (isWindows) mainWindow.setBackgroundMaterial(value.glassEnabled ? "mica" : "none")
}

function readYaml(file) {
  try {
    return YAML.parse(fs.readFileSync(file, "utf8")) || {}
  } catch {
    return {}
  }
}

function readMergedYaml(directory, name) {
  return {
    ...readYaml(path.join(directory, "config", "default_config", `${name}.yaml`)),
    ...readYaml(path.join(directory, "config", "config", `${name}.yaml`)),
  }
}

function getServerConfig() {
  const server = readMergedYaml(settings.yunzaiPath, "server")
  return {
    port: Number(server.port) || 2536,
    auth: server.auth && typeof server.auth === "object" ? server.auth : {},
  }
}

function plainLog(value) {
  return String(value).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
}

function pushLog(source, chunk) {
  const entries = plainLog(chunk)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter(Boolean)
    .map(message => ({ time: Date.now(), source, message }))
  if (!entries.length) return
  logs.push(...entries)
  if (logs.length > logLimit) logs = logs.slice(-logLimit)
  mainWindow?.webContents.send("yunzai:logs", entries)
}

function processState() {
  return {
    running: Boolean(yunzaiProcess && yunzaiProcess.exitCode === null),
    maintenance: Boolean(maintenanceProcess && maintenanceProcess.exitCode === null),
    pid: yunzaiProcess?.pid || null,
    startedAt,
    runtime: runtime?.status() || {},
    restartSuspended,
  }
}

function canConnect(port, host = "127.0.0.1") {
  return new Promise(resolve => {
    const socket = net.createConnection({ port, host })
    const finish = value => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(500)
    socket.once("connect", () => finish(true))
    socket.once("timeout", () => finish(false))
    socket.once("error", () => finish(false))
  })
}

async function waitForPort(port, occupied, timeout = 10000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if ((await canConnect(port)) === occupied) return true
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return false
}

function sendState() {
  mainWindow?.webContents.send("yunzai:state", processState())
}

function commandExists(command) {
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) return fs.existsSync(command)
  const extensions = isWindows ? ["", ".exe", ".cmd", ".bat"] : [""]
  return (process.env.PATH || "").split(path.delimiter).some(directory =>
    extensions.some(extension => fs.existsSync(path.join(directory, `${command}${extension}`))),
  )
}

function environmentInfo() {
  const directory = settings.yunzaiPath
  const valid = isYunzaiDirectory(directory)
  const bundled = runtime.status()
  const selectedNode =
    settings.nodePath && settings.nodePath !== "auto" ? settings.nodePath : runtime.executable("node", "node")
  return {
    valid,
    path: directory,
    node: bundled.node || commandExists(selectedNode),
    git: bundled.git || commandExists("git"),
    pnpm: bundled.pnpm || commandExists("pnpm"),
    redis: bundled.redis || commandExists("redis-server"),
    ffmpeg: bundled.ffmpeg || commandExists("ffmpeg"),
    bundled,
    dependencies: valid && fs.existsSync(path.join(directory, "node_modules")),
    server: getServerConfig(),
  }
}

async function startYunzai({ automatic = false } = {}) {
  if (yunzaiProcess && yunzaiProcess.exitCode === null) return processState()
  if (maintenanceProcess && maintenanceProcess.exitCode === null) throw new Error("维护任务正在运行，请稍后再试")
  if (!isYunzaiDirectory(settings.yunzaiPath)) throw new Error("请选择有效的 Yunzai 根目录")
  if (!fs.existsSync(path.join(settings.yunzaiPath, "node_modules"))) {
    throw new Error("当前实例尚未安装依赖，请先点击“安装项目依赖”")
  }
  const { port } = getServerConfig()
  if (await canConnect(port)) {
    throw new Error(`端口 ${port} 已被占用。请先关闭占用该端口的旧 Yunzai 或其他程序`)
  }

  stopping = false
  if (!automatic) {
    crashHistory = []
    restartSuspended = false
  }
  clearTimeout(restartTimer)
  pushLog("desktop", `正在启动 ${settings.yunzaiPath}`)
  await runtime.startRedis(readMergedYaml(settings.yunzaiPath, "redis"))

  const nodeExecutable =
    settings.nodePath && settings.nodePath !== "auto" ? settings.nodePath : runtime.executable("node", "node")
  const generation = ++processGeneration
  const child = spawn(nodeExecutable, ["app.js", "start"], {
    cwd: settings.yunzaiPath,
    env: runtime.environment({ FORCE_TTY: "1", FORCE_COLOR: "1" }),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
  yunzaiProcess = child
  startedAt = Date.now()
  child.stdout.on("data", data => pushLog("stdout", data))
  child.stderr.on("data", data => pushLog("stderr", data))
  child.on("error", error => {
    pushLog("desktop", `启动失败：${error.message}`)
    sendState()
  })
  child.on("exit", (code, signal) => {
    const wasStopping = stopping || generation !== processGeneration
    const uptime = Date.now() - startedAt
    pushLog("desktop", `Yunzai 已退出，代码 ${code ?? "-"}，信号 ${signal ?? "-"}`)
    if (yunzaiProcess === child) {
      yunzaiProcess = undefined
      startedAt = 0
    }
    sendState()
    if (!wasStopping && settings.autoRestart && !app.isQuitting && generation === processGeneration) {
      const now = Date.now()
      crashHistory = crashHistory.filter(time => now - time < 5 * 60 * 1000)
      if (uptime < 2 * 60 * 1000) crashHistory.push(now)
      else crashHistory = []
      if (crashHistory.length >= 5) {
        restartSuspended = true
        pushLog("desktop", "Yunzai 在 5 分钟内连续异常退出 5 次，已暂停自动重启")
        sendState()
        return
      }
      const delay = Math.min(60000, 3000 * 2 ** Math.max(0, crashHistory.length - 1))
      pushLog("desktop", `检测到异常退出，${Math.round(delay / 1000)} 秒后尝试自动重启`)
      restartTimer = setTimeout(() => {
        if (generation !== processGeneration || yunzaiProcess) return
        startYunzai({ automatic: true }).catch(error => {
          pushLog("desktop", `自动重启失败：${error.message}`)
        })
      }, delay)
    }
  })
  sendState()
  return processState()
}

function waitForExit(child, timeout) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null) return resolve(true)
    const timer = setTimeout(() => resolve(false), timeout)
    child.once("exit", () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

async function forceKill(child) {
  if (!child || child.exitCode !== null) return
  if (isWindows) {
    await new Promise(resolve => {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      }).once("exit", resolve)
    })
  } else {
    child.kill("SIGKILL")
  }
}

async function stopYunzai() {
  const child = yunzaiProcess
  if (!child || child.exitCode !== null) return processState()
  stopping = true
  processGeneration++
  clearTimeout(restartTimer)
  pushLog("desktop", "正在停止 Yunzai")
  const { port, auth } = getServerConfig()
  try {
    await fetch(`http://127.0.0.1:${port}/exit`, {
      headers: Object.fromEntries(Object.entries(auth).map(([key, value]) => [key, String(value)])),
      signal: AbortSignal.timeout(3000),
    })
  } catch {}
  if (!(await waitForExit(child, 8000))) {
    pushLog("desktop", "优雅停止超时，正在结束进程树")
    await forceKill(child)
  }
  const released = await waitForPort(port, false, 10000)
  if (!released) {
    pushLog("desktop", `端口 ${port} 在停止后仍被占用，已阻止自动重启`)
    restartSuspended = true
  }
  if (yunzaiProcess === child) yunzaiProcess = undefined
  startedAt = 0
  stopping = false
  sendState()
  return processState()
}

async function restartYunzai() {
  await stopYunzai()
  const { port } = getServerConfig()
  if (await canConnect(port)) throw new Error(`端口 ${port} 尚未释放，已取消重启`)
  return startYunzai()
}

async function runMaintenance(command, args, label, cwd = settings.yunzaiPath, options = {}) {
  if (options.allowWhileRunning !== true && yunzaiProcess && yunzaiProcess.exitCode === null) {
    throw new Error("请先停止 Yunzai")
  }
  if (maintenanceProcess && maintenanceProcess.exitCode === null) throw new Error("已有维护任务正在运行")
  if (options.requireInstance !== false && !isYunzaiDirectory(settings.yunzaiPath)) {
    throw new Error("请选择有效的 Yunzai 根目录")
  }
  pushLog("desktop", `${label}开始`)
  maintenanceProcess = spawn(command, args, {
    cwd,
    env: runtime.environment({ FORCE_COLOR: "1" }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: isWindows && /\.(cmd|bat)$/i.test(command),
  })
  maintenanceProcess.stdout.on("data", data => pushLog("task", data))
  maintenanceProcess.stderr.on("data", data => pushLog("task", data))
  sendState()
  const child = maintenanceProcess
  let code
  try {
    code = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", resolve)
    })
  } catch (error) {
    pushLog("desktop", `${label}启动失败：${error.message}`)
    throw error
  } finally {
    if (maintenanceProcess === child) maintenanceProcess = undefined
    sendState()
  }
  pushLog("desktop", `${label}${code === 0 ? "完成" : `失败，退出代码 ${code}`}`)
  if (code !== 0) throw new Error(`${label}失败，请查看控制台日志`)
  return environmentInfo()
}

async function installFramework() {
  const target = frameworkInstallPath()
  if (isYunzaiDirectory(target)) {
    settings.yunzaiPath = target
    writeSettings(settings)
    pushLog("desktop", `已接管现有 Yunzai：${target}`)
  } else {
    if (fs.existsSync(target) && fs.readdirSync(target).length) {
      throw new Error(`安装目录非空且不是有效的 Yunzai：${target}`)
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    await runMaintenance(
      runtime.executable("git", "git"),
      ["clone", "--depth", "1", frameworkRepository, target],
      "Yunzai 框架下载",
      path.dirname(target),
      { requireInstance: false },
    )
    if (!isYunzaiDirectory(target)) throw new Error("下载完成，但目标目录不是有效的 Yunzai 框架")
    settings.yunzaiPath = target
    writeSettings(settings)
  }
  await runMaintenance(
    runtime.executable("pnpm", isWindows ? "pnpm.cmd" : "pnpm"),
    ["install"],
    "Yunzai 依赖安装",
    target,
  )
  return {
    settings,
    environment: environmentInfo(),
    state: processState(),
    framework: {
      repository: frameworkRepository,
      target,
      installed: true,
    },
  }
}

async function installPlugin(url) {
  const target = instance.pluginTargetFromUrl(url)
  const directory = path.basename(target)
  if (fs.existsSync(target)) throw new Error("目标插件目录已存在")
  await runMaintenance(
    runtime.executable("git", "git"),
    ["clone", "--depth", "1", String(url), target],
    "插件下载",
    settings.yunzaiPath,
    { allowWhileRunning: true },
  )
  await runMaintenance(
    runtime.executable("pnpm", isWindows ? "pnpm.cmd" : "pnpm"),
    ["install", `--filter=${directory}`],
    `插件依赖安装 (${directory})`,
    settings.yunzaiPath,
    { allowWhileRunning: true },
  )
  return instance.listPlugins()
}

async function installDependency(specifier) {
  const value = String(specifier || "").trim()
  if (!value || /\s/.test(value) || value.startsWith("-")) {
    throw new Error("请输入有效的依赖名，例如 lodash 或 lodash@latest")
  }
  await runMaintenance(
    runtime.executable("pnpm", isWindows ? "pnpm.cmd" : "pnpm"),
    ["add", value, "-w"],
    `安装依赖 ${value}`,
    settings.yunzaiPath,
    { allowWhileRunning: true },
  )
  return instance.listDependencies()
}

function guobaInfo() {
  const installed = instance.listPlugins().some(plugin => plugin.directory === "guoba-plugin")
  const { port } = getServerConfig()
  return {
    installed,
    port,
    url: `http://localhost:${port}/guoba`,
  }
}

function createWindow() {
  const icon = path.join(__dirname, "assets", "favicon.ico")
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: "#0b1020",
    title: "DYunzai",
    frame: false,
    icon,
    opacity: settings.glassEnabled ? settings.opacity : 1,
    backgroundMaterial: isWindows && settings.glassEnabled ? "mica" : "none",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  })
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"))
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: "deny" }
  })
  mainWindow.on("close", event => {
    if (!app.isQuitting && settings.minimizeToTray) {
      event.preventDefault()
      mainWindow.hide()
    }
  })
  updateWindowAppearance()
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, "assets", "favicon.ico"))
  tray = new Tray(icon)
  tray.setToolTip("DYunzai")
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示主窗口", click: () => mainWindow.show() },
      { label: "启动 Yunzai", click: () => startYunzai().catch(error => pushLog("desktop", error.message)) },
      { label: "停止 Yunzai", click: () => void stopYunzai() },
      { type: "separator" },
      {
        label: "退出",
        click: async () => {
          app.isQuitting = true
          await stopYunzai()
          await runtime.stopRedis()
          app.quit()
        },
      },
    ]),
  )
  tray.on("double-click", () => mainWindow.show())
}

function registerIpc() {
  ipcMain.handle("app:init", () => ({
    settings,
    state: processState(),
    environment: environmentInfo(),
    logs,
    darkMode: nativeTheme.shouldUseDarkColors,
    framework: {
      repository: frameworkRepository,
      target: frameworkInstallPath(),
      installed: isYunzaiDirectory(frameworkInstallPath()),
    },
    guoba: guobaInfo(),
  }))
  ipcMain.handle("framework:install", () => installFramework())
  ipcMain.handle("settings:choose-framework-path", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择 Yunzai 安装目录",
      defaultPath: frameworkInstallPath(),
      buttonLabel: "选择此目录",
      properties: ["openDirectory", "createDirectory"],
    })
    if (result.canceled) return null
    const directory = path.resolve(result.filePaths[0])
    settings.frameworkPath = directory
    writeSettings(settings)
    return {
      settings,
      framework: {
        repository: frameworkRepository,
        target: directory,
        installed: isYunzaiDirectory(directory),
      },
    }
  })
  ipcMain.handle("settings:choose-yunzai", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择 Yunzai 根目录",
      defaultPath: settings.yunzaiPath,
      properties: ["openDirectory"],
    })
    if (result.canceled) return null
    const directory = result.filePaths[0]
    if (!isYunzaiDirectory(directory)) throw new Error("所选目录不是有效的 Yunzai 根目录")
    settings.yunzaiPath = directory
    writeSettings(settings)
    return { settings, environment: environmentInfo(), state: processState() }
  })
  ipcMain.handle("settings:save", (_event, patch) => {
    settings = { ...settings, ...patch }
    settings.opacity = Math.min(1, Math.max(0.7, Number(settings.opacity) || 0.92))
    writeSettings(settings)
    app.setLoginItemSettings({ openAtLogin: Boolean(settings.openAtLogin) })
    updateWindowAppearance()
    return settings
  })
  ipcMain.handle("settings:preview-appearance", (_event, value) => {
    updateWindowAppearance(value)
    return true
  })
  ipcMain.handle("window:minimize", () => mainWindow.minimize())
  ipcMain.handle("window:toggle-maximize", () => {
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
    return mainWindow.isMaximized()
  })
  ipcMain.handle("window:close", () => mainWindow.close())
  ipcMain.handle("environment:refresh", () => environmentInfo())
  ipcMain.handle("yunzai:start", () => startYunzai())
  ipcMain.handle("yunzai:stop", () => stopYunzai())
  ipcMain.handle("yunzai:restart", () => restartYunzai())
  ipcMain.handle("yunzai:command", (_event, command) => {
    if (!yunzaiProcess?.stdin?.writable) throw new Error("Yunzai 尚未运行")
    const value = String(command).trim()
    yunzaiProcess.stdin.write(`${value}\n`)
    pushLog("input", `> ${value}`)
  })
  ipcMain.handle("yunzai:install-dependencies", () =>
    runMaintenance(
      runtime.executable("pnpm", isWindows ? "pnpm.cmd" : "pnpm"),
      ["install"],
      "项目依赖安装",
      settings.yunzaiPath,
      { allowWhileRunning: true },
    ),
  )
  ipcMain.handle("yunzai:clear-logs", () => {
    logs = []
    return true
  })
  ipcMain.handle("console:context-menu", (_event, payload = {}) => {
    const selectedText = String(payload.selectedText || "")
    const lineText = String(payload.lineText || "")
    const allText = String(payload.allText || "")
    Menu.buildFromTemplate([
      {
        label: "复制选中内容",
        enabled: Boolean(selectedText),
        click: () => clipboard.writeText(selectedText),
      },
      {
        label: "复制此行",
        enabled: Boolean(lineText),
        click: () => clipboard.writeText(lineText),
      },
      { type: "separator" },
      {
        label: "复制全部日志",
        enabled: Boolean(allText),
        click: () => clipboard.writeText(allText),
      },
    ]).popup({ window: mainWindow })
    return true
  })
  ipcMain.handle("yunzai:open-directory", () => shell.openPath(settings.yunzaiPath))
  ipcMain.handle("config:list", () => instance.listConfigs())
  ipcMain.handle("config:get", (_event, name) => instance.getConfig(name))
  ipcMain.handle("config:save", (_event, payload) => instance.saveConfig(payload.name, payload.content))
  ipcMain.handle("plugins:list", () => instance.listPlugins())
  ipcMain.handle("plugins:open-repository", (_event, url) => {
    const target = String(url || "")
    if (!/^https?:\/\//i.test(target)) throw new Error("插件没有可用的仓库地址")
    return shell.openExternal(target)
  })
  ipcMain.handle("plugins:install", (_event, url) => installPlugin(url))
  ipcMain.handle("plugins:remove", (_event, name) => {
    const archived = instance.archivePlugin(name)
    pushLog("desktop", `插件已移至回收目录：${archived}`)
    return instance.listPlugins()
  })
  ipcMain.handle("plugins:config-list", (_event, directory) => instance.listPluginConfigFiles(directory))
  ipcMain.handle("plugins:config-get", (_event, payload) =>
    instance.getPluginConfig(payload.directory, payload.target),
  )
  ipcMain.handle("plugins:config-save", (_event, payload) =>
    instance.savePluginConfig(payload.directory, payload.target, payload.content),
  )
  ipcMain.handle("plugins:workspace-get", (_event, directory) => instance.getPluginWorkspace(directory))
  ipcMain.handle("plugins:workspace-save", (_event, payload) =>
    instance.savePluginWorkspace(payload.directory, payload.data),
  )
  ipcMain.handle("js-plugins:list", () => instance.listJsPlugins())
  ipcMain.handle("js-plugins:toggle", (_event, payload) =>
    instance.toggleJsPlugin(payload.fileName, payload.enabled),
  )
  ipcMain.handle("dependencies:list", () => instance.listDependencies())
  ipcMain.handle("dependencies:add", (_event, specifier) => installDependency(specifier))
  ipcMain.handle("database:list", (_event, pattern) => redis.overview(pattern))
  ipcMain.handle("database:get", (_event, key) => redis.get(key))
  ipcMain.handle("database:save", (_event, payload) => redis.save(payload))
  ipcMain.handle("database:delete", (_event, key) => redis.delete(key))
  ipcMain.handle("guoba:info", () => guobaInfo())
  ipcMain.handle("market:list", (_event, force) => market.list(force))
  ipcMain.handle("files:list", (_event, relativePath) => instance.listDirectory(relativePath))
  ipcMain.handle("files:read", (_event, relativePath) => instance.readTextFile(relativePath))
  ipcMain.handle("files:write", (_event, payload) => instance.writeTextFile(payload.relativePath, payload.content))
  ipcMain.handle("files:mkdir", (_event, relativePath) => instance.createDirectory(relativePath))
  ipcMain.handle("files:rename", (_event, payload) => instance.renameEntry(payload.relativePath, payload.newName))
  ipcMain.handle("files:archive", (_event, relativePath) => instance.archiveEntry(relativePath))
}

app.whenReady().then(() => {
  settings = readSettings()
  runtime = new RuntimeManager({
    app,
    sourceRoot: __dirname,
    log: (source, message) => pushLog(source, message),
  })
  instance = new InstanceManager(() => settings.yunzaiPath)
  market = new MarketManager(path.join(app.getPath("userData"), "cache"))
  redis = new RedisManager(
    () => readMergedYaml(settings.yunzaiPath, "redis"),
    () => runtime.startRedis(readMergedYaml(settings.yunzaiPath, "redis")),
  )
  app.setLoginItemSettings({ openAtLogin: Boolean(settings.openAtLogin) })
  registerIpc()
  createWindow()
  createTray()
  nativeTheme.on("updated", () => {
    updateWindowAppearance()
    mainWindow?.webContents.send("theme:changed", nativeTheme.shouldUseDarkColors)
  })
  if (settings.autoStart) {
    mainWindow.webContents.once("did-finish-load", () => {
      startYunzai().catch(error => pushLog("desktop", error.message))
    })
  }
})

app.on("before-quit", event => {
  if (app.isQuitting || (!yunzaiProcess && !runtime?.redisProcess)) return
  event.preventDefault()
  app.isQuitting = true
  void stopYunzai()
    .then(() => runtime.stopRedis())
    .finally(() => app.quit())
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !settings?.minimizeToTray) app.quit()
})

app.on("activate", () => {
  if (mainWindow) mainWindow.show()
  else createWindow()
})
