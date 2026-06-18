import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"
import { baseConfigSchemas } from "./base-config-schemas.js"
import { parseGuobaSupport } from "./schema-manager.js"

const builtInPlugins = new Set(["adapter", "example", "other", "system"])
const editableExtensions = new Set([
  ".js",
  ".cjs",
  ".mjs",
  ".ts",
  ".json",
  ".yaml",
  ".yml",
  ".md",
  ".txt",
  ".html",
  ".css",
  ".scss",
  ".env",
  ".ini",
  ".toml",
  ".xml",
  ".sh",
  ".bat",
  ".ps1",
])
const ignoredDirectories = new Set([".git", "node_modules"])
const maxEditorBytes = 2 * 1024 * 1024
const configMeta = {
  bot: { title: "基础配置", description: "机器人运行、日志、更新和文件监听" },
  group: { title: "群组配置", description: "群聊权限、触发和行为设置" },
  renderer: { title: "渲染配置", description: "浏览器、截图和渲染参数" },
  server: { title: "服务配置", description: "HTTP 服务、端口和鉴权设置" },
  milky: { title: "适配器配置", description: "Milky 协议适配器参数" },
  satori: { title: "适配器配置", description: "Satori 协议适配器参数" },
  redis: { title: "数据存储", description: "Redis 连接与缓存参数" },
  db: { title: "数据存储", description: "数据库连接参数" },
  other: { title: "其他", description: "其他高级设置" },
}

function readYaml(file) {
  try {
    return YAML.parse(fs.readFileSync(file, "utf8")) || {}
  } catch {
    return {}
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return {}
  }
}

function normalizeRepositoryUrl(value) {
  let url = String(value || "").trim()
  if (!url) return ""
  url = url.replace(/^git\+/, "")
  const scp = url.match(/^git@([^:]+):(.+)$/)
  if (scp) url = `https://${scp[1]}/${scp[2]}`
  const ssh = url.match(/^ssh:\/\/git@([^/]+)\/(.+)$/)
  if (ssh) url = `https://${ssh[1]}/${ssh[2]}`
  url = url.replace(/\.git$/i, "")
  return /^https?:\/\//i.test(url) ? url : ""
}

function pluginRepository(directory, pkg, support) {
  try {
    const gitConfig = fs.readFileSync(path.join(directory, ".git", "config"), "utf8")
    const origin = gitConfig.match(/\[remote\s+"origin"\][\s\S]*?^\s*url\s*=\s*(.+)$/mi)?.[1]
    const normalized = normalizeRepositoryUrl(origin)
    if (normalized) return normalized
  } catch {}
  const repository = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url
  return normalizeRepositoryUrl(repository) || normalizeRepositoryUrl(support?.pluginInfo?.link)
}

function safeName(value) {
  return String(value || "")
    .replace(/\.git$/i, "")
    .replace(/[^a-zA-Z0-9._-]/g, "")
}

function toPosix(value) {
  return String(value || "").split(path.sep).join("/")
}

function configType(file) {
  return path.extname(file).toLowerCase() === ".json" ? "json" : "yaml"
}

function parseConfig(file, content) {
  return configType(file) === "json" ? JSON.parse(content) : YAML.parse(content)
}

function stringifyConfig(file, data) {
  return configType(file) === "json"
    ? `${JSON.stringify(data, null, 2)}\n`
    : YAML.stringify(data, { lineWidth: 0 })
}

function mergeDeep(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) return override ?? base
  if (!base || typeof base !== "object") return override
  if (!override || typeof override !== "object") return override ?? base
  const result = { ...base }
  for (const [key, value] of Object.entries(override)) {
    result[key] =
      value && typeof value === "object" && !Array.isArray(value)
        ? mergeDeep(base[key], value)
        : value
  }
  return result
}

export class InstanceManager {
  constructor(getRoot) {
    this.getRoot = getRoot
  }

  get root() {
    return path.resolve(this.getRoot())
  }

  get configDefault() {
    return path.join(this.root, "config", "default_config")
  }

  get configUser() {
    return path.join(this.root, "config", "config")
  }

  resolveInside(relativePath = "") {
    const target = path.resolve(this.root, String(relativePath || "."))
    const relation = path.relative(this.root, target)
    if (relation.startsWith("..") || path.isAbsolute(relation)) {
      throw new Error("路径超出当前 Yunzai 实例")
    }
    return target
  }

  resolvePlugin(directory) {
    const clean = safeName(directory)
    if (!clean || clean !== directory) throw new Error("插件目录名无效")
    const target = this.resolveInside(path.join("plugins", clean))
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      throw new Error("插件目录不存在")
    }
    return target
  }

  listConfigs() {
    if (!fs.existsSync(this.configDefault)) return []
    return fs
      .readdirSync(this.configDefault)
      .filter(name => /\.ya?ml$/i.test(name))
      .map(name => ({
        name: path.basename(name, path.extname(name)),
        fileName: name,
        customized: fs.existsSync(path.join(this.configUser, name)),
        title: configMeta[path.basename(name, path.extname(name))]?.title || "其他",
        description: configMeta[path.basename(name, path.extname(name))]?.description || "Yunzai 配置",
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  getConfig(name) {
    const clean = safeName(name)
    const candidates = [`${clean}.yaml`, `${clean}.yml`]
    const fileName = candidates.find(candidate => fs.existsSync(path.join(this.configDefault, candidate)))
    if (!fileName) throw new Error("配置文件不存在")

    const defaultFile = path.join(this.configDefault, fileName)
    const userFile = path.join(this.configUser, fileName)
    const schemas = (baseConfigSchemas[clean] || []).map(schema =>
      clean === "group" && schema.field
        ? { ...schema, field: `default.${schema.field}` }
        : schema,
    )
    return {
      name: clean,
      fileName,
      customized: fs.existsSync(userFile),
      data: { ...readYaml(defaultFile), ...readYaml(userFile) },
      schemas,
      content: YAML.stringify({ ...readYaml(defaultFile), ...readYaml(userFile) }, { lineWidth: 0 }),
    }
  }

  saveConfig(name, content) {
    const current = this.getConfig(name)
    const data = YAML.parse(String(content))
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("配置内容必须是 YAML 对象")
    }
    fs.mkdirSync(this.configUser, { recursive: true })
    fs.writeFileSync(path.join(this.configUser, current.fileName), YAML.stringify(data, { lineWidth: 0 }), "utf8")
    return this.getConfig(name)
  }

  listPlugins() {
    const pluginsDirectory = this.resolveInside("plugins")
    if (!fs.existsSync(pluginsDirectory)) return []
    return fs
      .readdirSync(pluginsDirectory, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => {
        const directory = path.join(pluginsDirectory, entry.name)
        const pkg = readJson(path.join(directory, "package.json"))
        const configFiles = this.listPluginConfigFiles(entry.name)
        const support = parseGuobaSupport(path.join(directory, "guoba.support.js"))
        return {
          directory: entry.name,
          name: pkg.name || entry.name,
          version: pkg.version || "",
          description: pkg.description || "",
          git: fs.existsSync(path.join(directory, ".git")),
          builtIn: builtInPlugins.has(entry.name),
          guobaSupport: fs.existsSync(path.join(directory, "guoba.support.js")),
          schemaCount: support?.schemas.length || 0,
          title: support?.pluginInfo?.title || pkg.name || entry.name,
          repository: pluginRepository(directory, pkg, support),
          configurable: configFiles.length > 0,
          configCount: configFiles.length,
        }
      })
      .sort((a, b) => Number(a.builtIn) - Number(b.builtIn) || a.name.localeCompare(b.name))
  }

  listPluginConfigFiles(directory) {
    const pluginRoot = this.resolvePlugin(directory)
    const results = new Map()
    const roots = [
      ["config", null],
      ["config/config", null],
      ["config/default_config", "config/config"],
      ["defSet", "config"],
      ["default_config", "config"],
    ]

    for (const [relativeRoot, targetRoot] of roots) {
      const absoluteRoot = path.join(pluginRoot, relativeRoot)
      if (!fs.existsSync(absoluteRoot)) continue
      for (const entry of fs.readdirSync(absoluteRoot, { withFileTypes: true })) {
        if (!entry.isFile() || !/\.(ya?ml|json)$/i.test(entry.name)) continue
        let sourceRelative = toPosix(path.join(relativeRoot, entry.name))
        let targetRelative = sourceRelative
        if (relativeRoot === "config/config") {
          const defaultCandidate = toPosix(path.join("config/default_config", entry.name))
          if (fs.existsSync(path.join(pluginRoot, defaultCandidate))) sourceRelative = defaultCandidate
        } else if (relativeRoot === "config") {
          const defaultCandidate = toPosix(path.join("defSet", entry.name))
          if (fs.existsSync(path.join(pluginRoot, defaultCandidate))) sourceRelative = defaultCandidate
        }
        if (targetRoot) {
          targetRelative = toPosix(path.join(targetRoot, entry.name))
          if (fs.existsSync(path.join(pluginRoot, targetRelative))) continue
        }
        const key = targetRelative.toLowerCase()
        if (!results.has(key)) {
          results.set(key, {
            name: entry.name,
            source: sourceRelative,
            target: targetRelative,
            customized: fs.existsSync(path.join(pluginRoot, targetRelative)),
            type: configType(entry.name),
          })
        }
      }
    }

    for (const entry of fs.readdirSync(pluginRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(ya?ml|json)$/i.test(entry.name)) continue
      if (["package.json", "package-lock.json", "pnpm-lock.yaml"].includes(entry.name.toLowerCase())) continue
      const key = entry.name.toLowerCase()
      if (!results.has(key)) {
        results.set(key, {
          name: entry.name,
          source: entry.name,
          target: entry.name,
          customized: true,
          type: configType(entry.name),
        })
      }
    }
    return [...results.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  getPluginWorkspace(directory) {
    const pluginRoot = this.resolvePlugin(directory)
    const files = this.listPluginConfigFiles(directory)
    const support = parseGuobaSupport(path.join(pluginRoot, "guoba.support.js")) || {
      pluginInfo: {},
      schemas: [],
      schemaGroups: [],
    }
    const configurations = files.map(file => this.getPluginConfig(directory, file.target))
    const data = {}
    if (configurations.length === 1) {
      Object.assign(data, configurations[0].data)
    } else {
      for (const config of configurations) {
        const key = path.basename(config.name, path.extname(config.name))
        data[key] = config.data
      }
    }
    const pkg = readJson(path.join(pluginRoot, "package.json"))
    return {
      directory,
      pluginInfo: {
        name: support.pluginInfo.name || directory,
        title: support.pluginInfo.title || pkg.name || directory,
        description: support.pluginInfo.description || pkg.description || "",
        author: support.pluginInfo.author || pkg.author || "",
        icon: support.pluginInfo.icon || "",
        iconColor: support.pluginInfo.iconColor || "",
      },
      schemas: support.schemas,
      schemaGroups: support.schemaGroups || [],
      data,
      files: configurations.map(config => ({
        name: config.name,
        target: config.target,
        key: path.basename(config.name, path.extname(config.name)),
        label: path.basename(config.name, path.extname(config.name)),
      })),
    }
  }

  savePluginWorkspace(directory, data) {
    const workspace = this.getPluginWorkspace(directory)
    if (!data || typeof data !== "object") throw new Error("插件配置数据无效")
    if (workspace.files.length === 1) {
      this.savePluginConfig(directory, workspace.files[0].target, stringifyConfig(workspace.files[0].name, data))
    } else {
      for (const file of workspace.files) {
        if (!Object.hasOwn(data, file.key)) continue
        this.savePluginConfig(
          directory,
          file.target,
          stringifyConfig(file.name, data[file.key]),
        )
      }
    }
    return this.getPluginWorkspace(directory)
  }

  getPluginConfig(directory, target) {
    const pluginRoot = this.resolvePlugin(directory)
    const item = this.listPluginConfigFiles(directory).find(file => file.target === target)
    if (!item) throw new Error("插件配置文件不存在")
    const sourceFile = path.join(pluginRoot, item.source)
    const targetFile = path.join(pluginRoot, item.target)
    const sourceData = parseConfig(sourceFile, fs.readFileSync(sourceFile, "utf8"))
    const data =
      item.customized && item.source !== item.target
        ? mergeDeep(sourceData, parseConfig(targetFile, fs.readFileSync(targetFile, "utf8")))
        : sourceData
    if (!data || typeof data !== "object") throw new Error("插件配置格式无效")
    return {
      ...item,
      directory,
      data,
      content: stringifyConfig(targetFile, data),
      guobaSupport: fs.existsSync(path.join(pluginRoot, "guoba.support.js")),
    }
  }

  savePluginConfig(directory, target, content) {
    const pluginRoot = this.resolvePlugin(directory)
    const item = this.listPluginConfigFiles(directory).find(file => file.target === target)
    if (!item) throw new Error("插件配置文件不存在")
    const targetFile = path.resolve(pluginRoot, item.target)
    if (!targetFile.startsWith(`${pluginRoot}${path.sep}`) && targetFile !== pluginRoot) {
      throw new Error("插件配置路径无效")
    }
    const data = parseConfig(targetFile, String(content))
    if (!data || typeof data !== "object") throw new Error("配置内容必须是对象或数组")
    fs.mkdirSync(path.dirname(targetFile), { recursive: true })
    fs.writeFileSync(targetFile, stringifyConfig(targetFile, data), "utf8")
    return this.getPluginConfig(directory, item.target)
  }

  pluginTargetFromUrl(url) {
    let name
    try {
      name = new URL(url).pathname.split("/").filter(Boolean).pop()
    } catch {
      name = String(url).split(/[\\/]/).filter(Boolean).pop()
    }
    name = safeName(name)
    if (!name) throw new Error("无法从仓库地址确定插件目录名")
    return this.resolveInside(path.join("plugins", name))
  }

  archivePlugin(name) {
    const clean = safeName(name)
    if (builtInPlugins.has(clean)) throw new Error("不能卸载 Yunzai 内置插件")
    const source = this.resolvePlugin(clean)
    const trash = this.resolveInside(path.join("data", "desktop-trash"))
    fs.mkdirSync(trash, { recursive: true })
    const target = path.join(trash, `${clean}-${Date.now()}`)
    fs.renameSync(source, target)
    return target
  }

  listDependencies() {
    const pkg = readJson(path.join(this.root, "package.json"))
    const groups = [
      ["dependencies", "运行依赖"],
      ["devDependencies", "开发依赖"],
      ["optionalDependencies", "可选依赖"],
      ["peerDependencies", "对等依赖"],
    ]
    return groups
      .flatMap(([field, label]) =>
        Object.entries(pkg[field] || {}).map(([name, version]) => ({
          name,
          version: String(version),
          type: field,
          typeLabel: label,
        })),
      )
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  listDirectory(relativePath = "") {
    const directory = this.resolveInside(relativePath)
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
      throw new Error("目录不存在")
    }
    const relative = toPosix(path.relative(this.root, directory))
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .filter(entry => !ignoredDirectories.has(entry.name) || relative !== "")
      .map(entry => {
        const absolute = path.join(directory, entry.name)
        const stat = fs.statSync(absolute)
        const extension = path.extname(entry.name).toLowerCase()
        return {
          name: entry.name,
          path: toPosix(path.relative(this.root, absolute)),
          directory: entry.isDirectory(),
          editable: entry.isFile() && (editableExtensions.has(extension) || !extension) && stat.size <= maxEditorBytes,
          size: stat.size,
          modifiedAt: stat.mtimeMs,
        }
      })
      .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))
    return {
      path: relative,
      parent: relative ? toPosix(path.dirname(relative)) === "." ? "" : toPosix(path.dirname(relative)) : null,
      entries,
    }
  }

  readTextFile(relativePath) {
    const file = this.resolveInside(relativePath)
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error("文件不存在")
    const stat = fs.statSync(file)
    if (stat.size > maxEditorBytes) throw new Error("文件超过 2 MB，无法在内置编辑器中打开")
    if (fs.readFileSync(file, { encoding: null, flag: "r" }).subarray(0, 8000).includes(0)) {
      throw new Error("二进制文件无法编辑")
    }
    return {
      path: toPosix(path.relative(this.root, file)),
      content: fs.readFileSync(file, "utf8"),
      size: stat.size,
      modifiedAt: stat.mtimeMs,
    }
  }

  writeTextFile(relativePath, content) {
    const file = this.resolveInside(relativePath)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, String(content), "utf8")
    return this.readTextFile(relativePath)
  }

  createDirectory(relativePath) {
    const directory = this.resolveInside(relativePath)
    fs.mkdirSync(directory, { recursive: false })
    return this.listDirectory(toPosix(path.dirname(relativePath)) === "." ? "" : toPosix(path.dirname(relativePath)))
  }

  renameEntry(relativePath, newName) {
    const clean = String(newName || "").trim()
    if (!clean || clean === "." || clean === ".." || /[\\/:*?"<>|]/.test(clean)) {
      throw new Error("名称包含无效字符")
    }
    const source = this.resolveInside(relativePath)
    const target = this.resolveInside(path.join(path.dirname(relativePath), clean))
    if (!fs.existsSync(source)) throw new Error("文件或目录不存在")
    if (fs.existsSync(target)) throw new Error("同名文件或目录已存在")
    fs.renameSync(source, target)
    return toPosix(path.relative(this.root, target))
  }

  archiveEntry(relativePath) {
    const source = this.resolveInside(relativePath)
    if (source === this.root) throw new Error("不能删除 Yunzai 根目录")
    if (!fs.existsSync(source)) throw new Error("文件或目录不存在")
    const trash = this.resolveInside(path.join("data", "desktop-trash", "files"))
    fs.mkdirSync(trash, { recursive: true })
    const target = path.join(trash, `${path.basename(source)}-${Date.now()}`)
    fs.renameSync(source, target)
    return target
  }

  listJsPlugins() {
    const directory = this.resolveInside(path.join("plugins", "example"))
    if (!fs.existsSync(directory)) return []
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && (/\.js$/i.test(entry.name) || /\.js\.disable$/i.test(entry.name)))
      .map(entry => {
        const disabled = /\.disable$/i.test(entry.name)
        const file = path.join(directory, entry.name)
        const stat = fs.statSync(file)
        return {
          name: entry.name.replace(/\.js(?:\.disable)?$/i, ""),
          fileName: entry.name,
          path: toPosix(path.relative(this.root, file)),
          enabled: !disabled,
          size: stat.size,
          modifiedAt: stat.mtimeMs,
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  toggleJsPlugin(fileName, enabled) {
    const clean = path.basename(String(fileName))
    if (!/\.js(?:\.disable)?$/i.test(clean)) throw new Error("JS 插件文件名无效")
    const directory = this.resolveInside(path.join("plugins", "example"))
    const source = path.join(directory, clean)
    if (!fs.existsSync(source)) throw new Error("JS 插件不存在")
    const base = clean.replace(/\.js(?:\.disable)?$/i, "")
    const target = path.join(directory, `${base}.js${enabled ? "" : ".disable"}`)
    if (source !== target) {
      if (fs.existsSync(target)) throw new Error("目标状态文件已存在")
      fs.renameSync(source, target)
    }
    return this.listJsPlugins()
  }
}
