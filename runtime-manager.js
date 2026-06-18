import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { spawn } from "node:child_process"

const isWindows = process.platform === "win32"

export class RuntimeManager {
  constructor({ app, sourceRoot, log }) {
    this.app = app
    this.sourceRoot = sourceRoot
    this.log = log
    this.redisProcess = null
  }

  get root() {
    return this.app.isPackaged
      ? path.join(process.resourcesPath, "runtime", "win-x64")
      : path.join(this.sourceRoot, "runtime", "win-x64")
  }

  get paths() {
    const root = this.root
    return {
      root,
      node: path.join(root, "node", isWindows ? "node.exe" : "bin/node"),
      npm: path.join(root, "node", isWindows ? "npm.cmd" : "bin/npm"),
      pnpm: path.join(root, "node", isWindows ? "pnpm.cmd" : "bin/pnpm"),
      git: path.join(root, "git", "cmd", isWindows ? "git.exe" : "git"),
      redis: path.join(root, "redis", isWindows ? "redis-server.exe" : "redis-server"),
      ffmpeg: path.join(root, "ffmpeg", "bin", isWindows ? "ffmpeg.exe" : "ffmpeg"),
      ffprobe: path.join(root, "ffmpeg", "bin", isWindows ? "ffprobe.exe" : "ffprobe"),
    }
  }

  exists(name) {
    return fs.existsSync(this.paths[name])
  }

  executable(name, fallback = name) {
    return this.exists(name) ? this.paths[name] : fallback
  }

  environment(extra = {}) {
    const bins = [
      path.dirname(this.executable("node", "node")),
      path.dirname(this.executable("git", "git")),
      path.dirname(this.executable("redis", "redis-server")),
      path.dirname(this.executable("ffmpeg", "ffmpeg")),
    ].filter(directory => directory && directory !== ".")

    return {
      ...process.env,
      PATH: [...bins, process.env.PATH || ""].join(path.delimiter),
      FFMPEG_PATH: this.executable("ffmpeg", "ffmpeg"),
      FFPROBE_PATH: this.executable("ffprobe", "ffprobe"),
      ...extra,
    }
  }

  status() {
    return {
      root: this.root,
      node: this.exists("node"),
      npm: this.exists("npm"),
      pnpm: this.exists("pnpm"),
      git: this.exists("git"),
      redis: this.exists("redis"),
      ffmpeg: this.exists("ffmpeg"),
      ffprobe: this.exists("ffprobe"),
      redisRunning: Boolean(this.redisProcess && this.redisProcess.exitCode === null),
    }
  }

  canConnect(port, host = "127.0.0.1") {
    return new Promise(resolve => {
      const socket = net.createConnection({ host, port })
      const done = result => {
        socket.destroy()
        resolve(result)
      }
      socket.setTimeout(500)
      socket.once("connect", () => done(true))
      socket.once("timeout", () => done(false))
      socket.once("error", () => done(false))
    })
  }

  async startRedis({ host = "127.0.0.1", port = 6379 } = {}) {
    if (host !== "127.0.0.1" && host !== "localhost") return false
    if (await this.canConnect(port, host)) {
      this.log("runtime", `Redis 已在 ${host}:${port} 运行`)
      return true
    }
    if (!this.exists("redis")) {
      this.log("runtime", "未找到内置 Redis，将由 Yunzai 尝试启动系统 Redis")
      return false
    }

    const dataDirectory = path.join(this.app.getPath("userData"), "redis")
    fs.mkdirSync(dataDirectory, { recursive: true })
    this.log("runtime", `正在启动内置 Redis ${port}`)
    this.redisProcess = spawn(
      this.paths.redis,
      [
        "--bind",
        "127.0.0.1",
        "--port",
        String(port),
        "--dir",
        dataDirectory,
        "--dbfilename",
        "dump.rdb",
        "--appendonly",
        "yes",
      ],
      {
        cwd: path.dirname(this.paths.redis),
        env: this.environment(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    )
    this.redisProcess.stdout.on("data", data => this.log("redis", data))
    this.redisProcess.stderr.on("data", data => this.log("redis", data))
    this.redisProcess.on("exit", code => {
      this.log("runtime", `内置 Redis 已退出，代码 ${code ?? "-"}`)
      this.redisProcess = null
    })

    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 200))
      if (await this.canConnect(port, host)) return true
      if (!this.redisProcess || this.redisProcess.exitCode !== null) break
    }
    throw new Error("内置 Redis 启动失败，请查看控制台日志")
  }

  async stopRedis() {
    const child = this.redisProcess
    if (!child || child.exitCode !== null) return
    child.kill()
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 2000)
      child.once("exit", () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}
