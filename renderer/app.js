const api = window.yunzaiDesktop
const appIcon = (name, size = 15) => window.iconLibrary.icon(name, size)

function setButtonContent(button, iconName, label) {
  button.innerHTML = `${appIcon(iconName)}<span>${label}</span>`
}

function setIconButton(button, iconName, label) {
  button.classList.add("icon-button")
  button.innerHTML = appIcon(iconName)
  button.title = label
  button.dataset.tooltip = label
  button.setAttribute("aria-label", label)
}

function decorateStaticButtons() {
  const mapping = {
    refreshEnvironment: "refresh",
    openDirectoryButton: "open",
    installFrameworkButton: "download",
    installDependenciesButton: "package",
    refreshBaseConfig: "refresh",
    saveBaseConfig: "save",
    savePluginWorkspace: "save",
    refreshPluginsButton: "refresh",
    refreshMarketButton: "refresh",
    installPluginButton: "download",
    refreshJsPlugins: "refresh",
    refreshDependencies: "refresh",
    addDependencyButton: "plus",
    searchDatabaseButton: "search",
    newDatabaseKeyButton: "plus",
    refreshDatabaseButton: "refresh",
    deleteDatabaseKeyButton: "trash",
    saveDatabaseKeyButton: "save",
    reloadGuobaButton: "refresh",
    renameFileButton: "wrench",
    deleteFileButton: "trash",
    saveFileButton: "save",
    chooseDirectoryButton: "folder",
    chooseFrameworkPathButton: "folder",
    installFrameworkSettingsButton: "download",
    saveSettingsButton: "save",
  }
  for (const [id, iconName] of Object.entries(mapping)) {
    const button = document.getElementById(id)
    if (button && !button.querySelector(".app-icon")) {
      button.insertAdjacentHTML("afterbegin", appIcon(iconName))
    }
  }
}

const pageTitles = {
  overview: "首页",
  console: "控制台",
  baseConfig: "基础配置",
  pluginConfig: "插件配置",
  plugins: "插件管理",
  market: "插件市场",
  jsPlugins: "JS 插件管理",
  dependencies: "依赖管理",
  database: "数据库",
  guoba: "锅巴面板",
  files: "文件管理",
  settings: "设置",
}

let settings
let state
let environment
let framework
let guoba
let logs = []
let configs = []
let plugins = []
let dependencies = []
let databaseData = { entries: [], total: 0 }
let currentDatabaseKey
let jsPlugins = []
let marketData = { plugins: [] }
let currentBaseConfig
let currentPluginWorkspace
let currentPluginTab = ""
let currentPluginTabs = []
let marketStatus = "all"
let currentDirectory = ""
let currentFile
let uptimeTimer
let toastTimer

const $ = selector => document.querySelector(selector)
const $$ = selector => [...document.querySelectorAll(selector)]

function showToast(message) {
  const toast = $("#toast")
  toast.textContent = message
  toast.classList.add("show")
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2800)
}

async function action(task, message) {
  try {
    const result = await task()
    if (message) showToast(message)
    return result
  } catch (error) {
    showToast(error.message || String(error))
    throw error
  }
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString("zh-CN", { hour12: false })
}

function formatDate(value) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false })
}

function formatSize(bytes) {
  if (!bytes) return bytes === 0 ? "0 B" : ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

function formatUptime(startedAt) {
  if (!startedAt) return "00:00:00"
  const total = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  return [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60]
    .map(value => String(value).padStart(2, "0"))
    .join(":")
}

function hexToRgb(hex) {
  const clean = String(hex).replace("#", "")
  if (!/^[0-9a-f]{6}$/i.test(clean)) return "109, 140, 255"
  return [0, 2, 4].map(index => Number.parseInt(clean.slice(index, index + 2), 16)).join(", ")
}

function applyAppearance(value = settings) {
  const color = value.themeColor || "#6d8cff"
  document.documentElement.style.setProperty("--primary", color)
  document.documentElement.style.setProperty("--primary-rgb", hexToRgb(color))
  document.body.classList.toggle("no-animations", value.animations === false)
  document.body.classList.toggle("glass", Boolean(value.glassEnabled))
}

function applySystemTheme(darkMode) {
  document.body.classList.toggle("light", !darkMode)
}

async function switchPage(name) {
  $$(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.page === name))
  $$(".page").forEach(page => page.classList.remove("active"))
  $(`#${name}Page`).classList.add("active")
  $("#pageTitle").textContent = pageTitles[name]
  if (name === "baseConfig") await loadConfigs()
  if (["pluginConfig", "plugins", "market"].includes(name)) await loadPlugins()
  if (name === "market" && !marketData.plugins.length) await loadMarket()
  if (name === "jsPlugins") await loadJsPlugins()
  if (name === "dependencies") await loadDependencies()
  if (name === "database") await loadDatabase()
  if (name === "guoba") renderGuobaPanel()
  if (name === "files") await loadDirectory(currentDirectory)
}

function renderState() {
  const running = state.running
  $("#statusDot").classList.toggle("running", running)
  $("#statusText").textContent = running ? "运行中" : state.maintenance ? "维护中" : "已停止"
  $("#statusDetail").textContent = running
    ? `PID ${state.pid}${state.maintenance ? " · 后台安装中" : ""}`
    : state.maintenance ? "正在执行安装任务" : "等待启动"
  $("#processStatus").textContent = running ? "运行中" : "已停止"
  $("#processPid").textContent = running ? `PID ${state.pid}` : "PID -"
  const runtime = state.runtime || {}
  const count = ["node", "pnpm", "git", "redis", "ffmpeg"].filter(key => runtime[key]).length
  $("#runtimeStatus").textContent = count === 5 ? "完整内置" : `${count}/5 可用`
  $("#runtimeDetail").textContent = runtime.redisRunning ? "内置 Redis 正在运行" : "Node · pnpm · Redis · FFmpeg · Git"
  $("#runtimeText").textContent = running ? "ONLINE" : "OFF"
  $(".runtime-orb").classList.toggle("online", running)
  $("#heroTitle").textContent = running ? "Yunzai 正在稳定运行" : "你的机器人控制台已就绪"
  $("#restartHint").textContent = state.restartSuspended ? "自动重启已熔断" : settings.autoRestart ? "自动重启已启用" : "自动重启已关闭"
  $("#startButton").disabled = running || state.maintenance
  $("#stopButton").disabled = !running
  $("#restartButton").disabled = !running || state.maintenance
  $("#installDependenciesButton").disabled = state.maintenance
  $("#installFrameworkButton").disabled = running || state.maintenance
  $("#installFrameworkSettingsButton").disabled = running || state.maintenance
  $("#addDependencyButton").disabled = state.maintenance
  $("#commandInput").disabled = !running
  renderGuobaPanel()
  clearInterval(uptimeTimer)
  const tick = () => { $("#uptime").textContent = formatUptime(state.startedAt) }
  tick()
  if (running) uptimeTimer = setInterval(tick, 1000)
}

function renderEnvironment() {
  const rows = [
    ["Yunzai 目录", environment.valid],
    ["Node.js", environment.node],
    ["内置 pnpm", environment.pnpm],
    ["Git", environment.git],
    ["Redis", environment.redis],
    ["FFmpeg", environment.ffmpeg],
    ["项目依赖", environment.dependencies],
  ]
  $("#environmentList").innerHTML = rows.map(([name, valid]) =>
    `<div class="environment-item"><span>${name}</span><b class="${valid ? "" : "missing"}">${valid ? "正常" : "缺失"}</b></div>`,
  ).join("")
}

function renderSettings() {
  $("#instancePath").textContent = settings.yunzaiPath
  $("#frameworkPathInput").value = framework?.target || ""
  $("#frameworkInstallHint").textContent = framework?.installed ? "框架已安装，可重新检查依赖" : `安装到 ${framework?.target || settings.frameworkPath}`
  $("#yunzaiPathInput").value = settings.yunzaiPath
  $("#nodePathInput").value = settings.nodePath
  $("#autoStartInput").checked = settings.autoStart
  $("#autoRestartInput").checked = settings.autoRestart
  $("#openAtLoginInput").checked = settings.openAtLogin
  $("#minimizeToTrayInput").checked = settings.minimizeToTray
  $("#themeColorInput").value = settings.themeColor
  $("#themeColorText").value = settings.themeColor
  $("#glassEnabledInput").checked = settings.glassEnabled
  $("#glassOpacityInput").value = Math.round((settings.opacity || 0.92) * 100)
  $("#glassOpacityValue").textContent = `${$("#glassOpacityInput").value}%`
  $("#glassOpacityInput").disabled = !settings.glassEnabled
  $("#glassOpacityField").classList.toggle("disabled", !settings.glassEnabled)
  $("#animationsInput").checked = settings.animations
  applyAppearance()
}

async function installYunzaiFramework() {
  await switchPage("console")
  const result = await action(api.installFramework, "Yunzai 框架和依赖安装完成")
  ;({ settings, environment, state, framework } = result)
  currentDirectory = ""
  currentBaseConfig = null
  currentPluginWorkspace = null
  renderSettings()
  renderEnvironment()
  renderState()
}

function appendLogs(entries) {
  logs.push(...entries)
  if (logs.length > 3000) logs = logs.slice(-3000)
  const fragment = document.createDocumentFragment()
  for (const entry of entries) {
    const row = document.createElement("div")
    row.className = `log-line ${entry.source}`
    row.innerHTML = `<span class="log-time"></span><span class="log-source"></span><span class="log-message"></span>`
    row.children[0].textContent = formatTime(entry.time)
    row.children[1].textContent = entry.source
    row.children[2].textContent = entry.message
    fragment.append(row)
  }
  const output = $("#consoleOutput")
  output.append(fragment)
  while (output.childElementCount > 3000) output.firstElementChild.remove()
  output.scrollTop = output.scrollHeight
  $("#consoleCount").textContent = `${logs.length} 条日志`
}

function getAtPath(data, field) {
  return String(field).split(".").reduce((value, key) => value?.[key], data)
}

function setAtPath(data, field, value) {
  const keys = String(field).split(".")
  let cursor = data
  for (const key of keys.slice(0, -1)) {
    if (!cursor[key] || typeof cursor[key] !== "object") cursor[key] = {}
    cursor = cursor[key]
  }
  cursor[keys.at(-1)] = value
}

function emptyValueLike(value) {
  if (Array.isArray(value)) return []
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, emptyValueLike(item)]))
  }
  if (typeof value === "number") return 0
  if (typeof value === "boolean") return false
  return ""
}

function structuredControl(initialValue, onChange) {
  const root = document.createElement("div")
  root.className = "collection-editor"
  let rootValue = structuredClone(initialValue)

  function valueNode(initial, update) {
    const host = document.createElement("div")
    let value = initial

    const render = () => {
      host.replaceChildren()
      if (Array.isArray(value)) {
        const list = document.createElement("div")
        list.className = "collection-list"
        value.forEach((item, index) => {
          const card = document.createElement("div")
          card.className = "collection-card"
          const header = document.createElement("div")
          header.className = "collection-card-header"
          const title = document.createElement("span")
          title.textContent = `第 ${index + 1} 项`
          const remove = document.createElement("button")
          remove.type = "button"
          setButtonContent(remove, "trash", "删除")
          remove.addEventListener("click", () => {
            value.splice(index, 1)
            update(value)
            render()
          })
          header.append(title, remove)
          card.append(header, valueNode(item, next => {
            value[index] = next
            update(value)
          }))
          list.append(card)
        })
        const add = document.createElement("button")
        add.type = "button"
        add.className = "collection-add"
        setButtonContent(add, "plus", "添加一项")
        add.addEventListener("click", () => {
          value.push(value.length ? emptyValueLike(value[0]) : "")
          update(value)
          render()
        })
        host.append(list, add)
        return
      }

      if (value && typeof value === "object") {
        const list = document.createElement("div")
        list.className = "collection-list"
        Object.entries(value).forEach(([key, item], index) => {
          const card = document.createElement("div")
          card.className = "collection-card object-card"
          const header = document.createElement("div")
          header.className = "collection-card-header"
          const keyInput = document.createElement("input")
          keyInput.className = "collection-key"
          keyInput.value = key
          keyInput.placeholder = "配置键"
          keyInput.addEventListener("change", () => {
            const nextKey = keyInput.value.trim()
            if (!nextKey || nextKey === key || Object.hasOwn(value, nextKey)) {
              keyInput.value = key
              return
            }
            const next = {}
            Object.entries(value).forEach(([currentKey, currentValue]) => {
              next[currentKey === key ? nextKey : currentKey] = currentValue
            })
            value = next
            update(value)
            render()
          })
          const remove = document.createElement("button")
          remove.type = "button"
          setButtonContent(remove, "trash", "删除")
          remove.addEventListener("click", () => {
            delete value[key]
            update(value)
            render()
          })
          header.append(keyInput, remove)
          card.append(header, valueNode(item, next => {
            value[key] = next
            update(value)
          }))
          list.append(card)
        })
        const add = document.createElement("button")
        add.type = "button"
        add.className = "collection-add"
        setButtonContent(add, "plus", "添加配置项")
        add.addEventListener("click", () => {
          let index = Object.keys(value).length + 1
          while (Object.hasOwn(value, `newKey${index}`)) index++
          value[`newKey${index}`] = ""
          update(value)
          render()
        })
        host.append(list, add)
        return
      }

      const input = document.createElement("input")
      if (typeof value === "boolean") {
        input.type = "checkbox"
        input.className = "track-switch collection-switch"
        input.checked = value
        input.addEventListener("change", () => {
          value = input.checked
          update(value)
        })
      } else {
        input.type = typeof value === "number" ? "number" : "text"
        input.value = value ?? ""
        input.addEventListener("input", () => {
          value = input.type === "number" ? Number(input.value) : input.value
          update(value)
        })
      }
      host.append(input)
    }

    render()
    return host
  }

  root.append(valueNode(rootValue, next => {
    rootValue = next
    onChange(next)
  }))
  return root
}

function controlFor(schema, value, onChange) {
  const component = String(schema.component || "").toLowerCase()
  const props = schema.componentProps || {}
  let input
  if (Array.isArray(value) || (value && typeof value === "object") || component.includes("tags")) {
    return structuredControl(value ?? [], onChange)
  } else if (component.includes("switch") || typeof value === "boolean") {
    input = document.createElement("input")
    input.type = "checkbox"
    input.className = "track-switch"
    const checkedValue = Object.hasOwn(props, "checkedValue") ? props.checkedValue : true
    const unCheckedValue = Object.hasOwn(props, "unCheckedValue") ? props.unCheckedValue : false
    input.checked = value === checkedValue || (checkedValue === true && Boolean(value))
    input.addEventListener("change", () => onChange(input.checked ? checkedValue : unCheckedValue))
  } else if ((component.includes("select") || component.includes("radio")) && Array.isArray(props.options)) {
    input = document.createElement("select")
    for (const item of props.options) {
      const option = document.createElement("option")
      const optionValue = typeof item === "object" ? item.value : item
      option.value = JSON.stringify(optionValue)
      option.textContent = typeof item === "object" ? item.label : item
      input.append(option)
    }
    input.value = JSON.stringify(value)
    input.addEventListener("change", () => {
      try { onChange(JSON.parse(input.value)) } catch { onChange(input.value) }
    })
  } else if (component.includes("color")) {
    input = document.createElement("input")
    input.type = "color"
    input.value = /^#[0-9a-f]{6}$/i.test(value) ? value : "#6d8cff"
    input.addEventListener("input", () => onChange(input.value))
  } else if (component.includes("number") || typeof value === "number") {
    input = document.createElement("input")
    input.type = "number"
    if (props.min !== undefined) input.min = props.min
    if (props.max !== undefined) input.max = props.max
    input.value = value ?? 0
    input.addEventListener("input", () => onChange(Number(input.value)))
  } else if (component.includes("textarea")) {
    input = document.createElement("textarea")
    input.value = value ?? ""
    input.addEventListener("input", () => onChange(input.value))
  } else {
    input = document.createElement("input")
    input.type = component.includes("password") ? "password" : "text"
    input.placeholder = props.placeholder || ""
    input.value = value ?? ""
    input.addEventListener("input", () => onChange(input.value))
  }
  return input
}

function schemaField(schema, value, onChange) {
  const row = document.createElement("div")
  row.className = "schema-field"
  const label = document.createElement("div")
  label.className = "schema-label"
  const strong = document.createElement("strong")
  strong.textContent = schema.label || schema.field
  const help = document.createElement("span")
  help.textContent = schema.bottomHelpMessage || schema.helpMessage || schema.field || ""
  label.append(strong, help)
  row.append(label, controlFor(schema, value, onChange))
  return row
}

function autoSchemas(data, prefix = "", depth = 0) {
  const result = []
  if (!data || typeof data !== "object" || depth > 5) return result
  for (const [key, value] of Object.entries(data)) {
    const field = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === "object" && !Array.isArray(value)) {
      result.push({ label: key, component: "SOFT_GROUP_BEGIN" })
      result.push(...autoSchemas(value, field, depth + 1))
    } else {
      result.push({ field, label: key, component: typeof value === "boolean" ? "Switch" : typeof value === "number" ? "InputNumber" : typeof value === "object" ? "InputTextArea" : "Input" })
    }
  }
  return result
}

function renderSchemaForm(container, schemas, data) {
  container.replaceChildren()
  container.classList.remove("empty-state")
  const usable = schemas?.some(item => item.field) ? schemas : autoSchemas(data)
  if (!usable.length) {
    container.classList.add("empty-state")
    container.textContent = "没有可编辑的配置字段"
    return
  }
  for (const schema of usable) {
    if (!schema.field) {
      const group = document.createElement("div")
      group.className = "form-group"
      group.textContent = schema.label || "配置分组"
      container.append(group)
      continue
    }
    container.append(schemaField(schema, getAtPath(data, schema.field), value => setAtPath(data, schema.field, value)))
  }
}

async function loadConfigs() {
  configs = await action(api.listConfigs)
  renderConfigLists()
}

function renderConfigLists() {
  const list = $("#baseConfigList")
  list.replaceChildren()
  for (const config of configs) {
    const button = document.createElement("button")
    button.className = "vertical-item"
    button.dataset.name = config.name
    button.innerHTML = `<div><span></span><small></small></div><b>${config.customized ? "已修改" : ""}</b>`
    button.querySelector("span").textContent = config.title === "其他" ? config.name : `${config.title} · ${config.name}`
    button.querySelector("small").textContent = config.description
    button.addEventListener("click", () => openBaseConfig(config.name))
    list.append(button)
  }
}

function markVerticalActive(container, value) {
  $(`${container}`).querySelectorAll(".vertical-item").forEach(item => item.classList.toggle("active", item.dataset.name === value || item.dataset.directory === value))
}

async function openBaseConfig(name) {
  currentBaseConfig = await action(() => api.getConfig(name))
  markVerticalActive("#baseConfigList", name)
  const meta = configs.find(item => item.name === name)
  $("#baseConfigTitle").textContent = `${meta?.title || name} · ${name}`
  $("#baseConfigDescription").textContent = meta?.description || ""
  renderSchemaForm($("#baseConfigForm"), currentBaseConfig.schemas, currentBaseConfig.data)
  $("#saveBaseConfig").disabled = false
}

async function loadPlugins() {
  plugins = await action(api.listPlugins)
  renderInstalledPlugins()
  renderPluginConfigList()
  await refreshGuobaInfo()
}

function renderPluginConfigList() {
  const query = $("#pluginConfigSearch").value.trim().toLowerCase()
  const list = $("#pluginConfigList")
  list.replaceChildren()
  for (const plugin of plugins.filter(item =>
    item.configurable && (!query || `${item.title} ${item.directory}`.toLowerCase().includes(query)),
  )) {
    const button = document.createElement("button")
    button.className = "vertical-item"
    button.dataset.directory = plugin.directory
    button.innerHTML = `<div><span></span><small></small></div><b></b>`
    button.querySelector("span").textContent = plugin.title
    button.querySelector("small").textContent = plugin.directory
    button.querySelector("b").textContent = plugin.guobaSupport ? `${plugin.schemaCount} 项` : "自动"
    button.addEventListener("click", () => openPluginWorkspace(plugin.directory))
    list.append(button)
  }
}

async function openPluginWorkspace(directory) {
  currentPluginWorkspace = await action(() => api.getPluginWorkspace(directory))
  markVerticalActive("#pluginConfigList", directory)
  $("#pluginConfigTitle").textContent = currentPluginWorkspace.pluginInfo.title
  $("#pluginConfigDescription").textContent = currentPluginWorkspace.pluginInfo.description || `${currentPluginWorkspace.schemas.length} 个 Guoba schema 配置项`
  currentPluginTabs = buildPluginTabs()
  currentPluginTab = currentPluginTabs[0]?.key || ""
  renderPluginTabs()
  renderPluginTab()
  $("#savePluginWorkspace").disabled = false
}

function labelSchemaGroups(schemas) {
  const groups = []
  let current
  for (const schema of schemas) {
    if (!schema.field && schema.component === "SOFT_GROUP_BEGIN") {
      if (current?.schemas.length) groups.push(current)
      current = {
        key: `label-group-${groups.length + 1}`,
        label: schema.label || `分类 ${groups.length + 1}`,
        schemas: [],
      }
      continue
    }
    if (!current) {
      current = {
        key: "label-group-general",
        label: "通用配置",
        schemas: [],
      }
    }
    current.schemas.push(schema)
  }
  if (current?.schemas.length) groups.push(current)
  return groups
}

function buildPluginTabs() {
  if (currentPluginWorkspace.schemaGroups?.length) {
    return currentPluginWorkspace.schemaGroups.map(group => ({ ...group, source: "schema" }))
  }
  const hasLabelGroups = currentPluginWorkspace.schemas.some(
    schema => !schema.field && schema.component === "SOFT_GROUP_BEGIN",
  )
  if (hasLabelGroups) {
    return labelSchemaGroups(currentPluginWorkspace.schemas).map(group => ({ ...group, source: "schema" }))
  }
  return currentPluginWorkspace.files.map(file => ({ ...file, source: "file" }))
}

function pluginTabs() {
  return currentPluginTabs
}

function schemasForPluginTab(key) {
  const tab = currentPluginTabs.find(item => item.key === key)
  if (tab?.source === "schema") return tab.schemas || []
  if (currentPluginWorkspace.files.length <= 1) return currentPluginWorkspace.schemas
  return currentPluginWorkspace.schemas.filter(schema => schema.field?.startsWith(`${key}.`))
}

function renderPluginTabs() {
  const tabs = $("#pluginConfigTabs")
  tabs.replaceChildren()
  const items = [...currentPluginTabs]
  tabs.hidden = items.length <= 1
  for (const file of items) {
    const button = document.createElement("button")
    button.textContent = file.label
    button.classList.toggle("active", file.key === currentPluginTab)
    button.addEventListener("click", () => {
      currentPluginTab = file.key
      renderPluginTabs()
      renderPluginTab()
    })
    tabs.append(button)
  }
}

function renderPluginTab() {
  const schemas = schemasForPluginTab(currentPluginTab)
  $("#pluginSchemaForm").scrollTop = 0
  if (schemas.length) {
    renderSchemaForm($("#pluginSchemaForm"), schemas, currentPluginWorkspace.data)
  } else {
    const scoped = currentPluginWorkspace.data[currentPluginTab] || currentPluginWorkspace.data
    renderSchemaForm(
      $("#pluginSchemaForm"),
      autoSchemas(scoped, pluginTabs().length > 1 && !currentPluginWorkspace.schemaGroups?.length ? currentPluginTab : ""),
      currentPluginWorkspace.data,
    )
  }
}

function renderInstalledPlugins() {
  const list = $("#pluginList")
  list.replaceChildren()
  for (const plugin of plugins) {
    const card = document.createElement("article")
    card.className = "plugin-card"
    card.innerHTML = `<div class="plugin-card-head"><div><strong></strong><span></span></div><div class="plugin-badge"></div></div><p></p><div class="card-actions"></div>`
    card.querySelector("strong").textContent = plugin.title
    card.querySelector("span").textContent = `${plugin.directory}${plugin.version ? ` · v${plugin.version}` : ""}`
    card.querySelector(".plugin-badge").textContent = plugin.guobaSupport ? `Guoba ${plugin.schemaCount}` : plugin.builtIn ? "内置" : "插件"
    card.querySelector("p").textContent = plugin.description || "暂无插件说明"
    if (plugin.configurable) {
      const configure = document.createElement("button")
      configure.className = "button ghost"
      setIconButton(configure, "settings", "配置")
      configure.addEventListener("click", async () => { await switchPage("pluginConfig"); await openPluginWorkspace(plugin.directory) })
      card.querySelector(".card-actions").append(configure)
    }
    if (plugin.repository) {
      const repository = document.createElement("button")
      repository.className = "button ghost"
      setIconButton(repository, "external", "打开仓库")
      repository.addEventListener("click", () => action(() => api.openPluginRepository(plugin.repository)))
      card.querySelector(".card-actions").append(repository)
    }
    if (!plugin.builtIn) {
      const remove = document.createElement("button")
      remove.className = "button danger"
      setIconButton(remove, "trash", "卸载")
      remove.addEventListener("click", async () => {
        if (!confirm(`确定卸载 ${plugin.title}？插件会移动到回收目录。`)) return
        await action(() => api.removePlugin(plugin.directory), "插件已卸载")
        await loadPlugins()
      })
      card.querySelector(".card-actions").append(remove)
    }
    list.append(card)
  }
}

async function loadMarket(force = false) {
  marketData = await action(() => api.listMarket(force), force ? "插件索引已更新" : "")
  const categories = [...new Set(marketData.plugins.map(item => item.category))]
  $("#marketCategory").innerHTML = '<option value="">全部分类</option>' + categories.map(item => `<option>${item}</option>`).join("")
  $("#marketMeta").textContent = `${marketData.source} · ${marketData.plugins.length} 个插件 · ${formatDate(marketData.updatedAt)}${marketData.stale ? " · 离线缓存" : ""}`
  renderMarket()
}

function repositoryName(url) {
  return url.split("/").filter(Boolean).pop()?.replace(/\.git$/i, "").toLowerCase()
}

function renderMarket() {
  const custom = marketStatus === "custom"
  $("#marketToolbar").hidden = custom
  $("#marketCustomInstall").hidden = !custom
  $("#marketMeta").hidden = custom
  $("#marketList").hidden = custom
  if (custom) return
  const query = $("#marketSearch").value.trim().toLowerCase()
  const category = $("#marketCategory").value
  const installed = new Set(plugins.map(item => item.directory.toLowerCase()))
  const list = $("#marketList")
  list.replaceChildren()
  for (const plugin of marketData.plugins.filter(item =>
    (!category || item.category === category) &&
    (marketStatus === "all" ||
      (marketStatus === "installed" && installed.has(repositoryName(item.url))) ||
      (marketStatus === "uninstalled" && !installed.has(repositoryName(item.url)))) &&
    (!query || `${item.name} ${item.author} ${item.description}`.toLowerCase().includes(query)),
  )) {
    const exists = installed.has(repositoryName(plugin.url))
    const card = document.createElement("article")
    card.className = "plugin-card"
    card.innerHTML = `<div class="plugin-card-head"><div><strong></strong><span></span></div><div class="plugin-badge"></div></div><p></p><div class="card-actions"></div>`
    card.querySelector("strong").textContent = plugin.name
    card.querySelector("span").textContent = plugin.author || "未知作者"
    card.querySelector(".plugin-badge").textContent = plugin.category
    card.querySelector("p").textContent = plugin.description || "暂无说明"
    const install = document.createElement("button")
    install.className = `button ${exists ? "ghost" : "primary"}`
    setIconButton(install, exists ? "package" : "download", exists ? "已安装" : "安装")
    install.disabled = exists
    install.addEventListener("click", async () => {
      install.disabled = true
      setIconButton(install, "download", "安装中...")
      try {
        await action(() => api.installPlugin(plugin.url), `${plugin.name} 安装完成，重启 Yunzai 后生效`)
        await loadPlugins()
      } finally {
        renderMarket()
      }
    })
    card.querySelector(".card-actions").append(install)
    list.append(card)
  }
}

async function loadJsPlugins() {
  jsPlugins = await action(api.listJsPlugins)
  renderJsPlugins()
}

function renderJsPlugins() {
  const query = $("#jsPluginSearch").value.trim().toLowerCase()
  const list = $("#jsPluginList")
  list.replaceChildren()
  for (const item of jsPlugins.filter(entry =>
    !query || `${entry.name} ${entry.fileName}`.toLowerCase().includes(query),
  )) {
    const row = document.createElement("div")
    row.className = "list-row"
    row.innerHTML = `<div><strong></strong><span></span></div><div class="card-actions"></div>`
    row.querySelector("strong").textContent = item.name
    row.querySelector("span").textContent = `${item.fileName} · ${formatSize(item.size)} · ${formatDate(item.modifiedAt)}`
    const source = document.createElement("button")
    source.className = "button ghost"
    setButtonContent(source, "code", "查看源码")
    source.addEventListener("click", async () => { await switchPage("files"); await openFile(item.path) })
    const toggle = document.createElement("button")
    toggle.className = `button ${item.enabled ? "danger" : "primary"}`
    setButtonContent(toggle, item.enabled ? "stop" : "play", item.enabled ? "关闭" : "启用")
    toggle.addEventListener("click", async () => {
      await action(() => api.toggleJsPlugin(item.fileName, !item.enabled), item.enabled ? "JS 插件已关闭" : "JS 插件已启用")
      await loadJsPlugins()
    })
    row.querySelector(".card-actions").append(source, toggle)
    list.append(row)
  }
}

async function loadDependencies() {
  dependencies = await action(api.listDependencies)
  renderDependencies()
}

function renderDependencies() {
  const query = $("#dependencySearch").value.trim().toLowerCase()
  const visible = dependencies.filter(item =>
    !query || `${item.name} ${item.version} ${item.typeLabel}`.toLowerCase().includes(query),
  )
  $("#dependencyMeta").textContent = `${dependencies.length} 个依赖 · 当前显示 ${visible.length} 个`
  const list = $("#dependencyList")
  list.replaceChildren()
  for (const item of visible) {
    const card = document.createElement("article")
    card.className = "dependency-card"
    card.innerHTML = "<div><strong></strong><span></span></div><b></b>"
    card.querySelector("strong").textContent = item.name
    card.querySelector("span").textContent = item.version
    card.querySelector("b").textContent = item.typeLabel
    list.append(card)
  }
}

function databasePattern() {
  const query = $("#databaseSearch").value.trim()
  if (!query) return "*"
  return /[*?[\]]/.test(query) ? query : `*${query}*`
}

async function loadDatabase() {
  databaseData = await action(() => api.listDatabaseKeys(databasePattern()))
  const { host, port, db } = databaseData.connection
  $("#databaseConnection").textContent = `${host}:${port} · DB ${db}`
  $("#databaseMeta").textContent = `${databaseData.total} 个键 · 当前显示 ${databaseData.entries.length} 个${databaseData.truncated ? " · 已限制为 500 条" : ""}`
  renderDatabaseKeys()
}

function renderDatabaseKeys() {
  const pane = $(".database-key-pane")
  const scrollTop = pane.scrollTop
  const list = $("#databaseKeyList")
  list.replaceChildren()
  for (const item of databaseData.entries) {
    const button = document.createElement("button")
    button.className = "database-key-item"
    button.dataset.key = item.key
    button.classList.toggle("active", currentDatabaseKey?.key === item.key)
    button.innerHTML = "<div><strong></strong><span></span></div><span class=\"database-type-badge\"></span>"
    button.querySelector("strong").textContent = item.key
    button.querySelector("div span").textContent = item.ttl < 0 ? "永久" : `TTL ${item.ttl} 秒`
    button.querySelector(".database-type-badge").textContent = item.type
    button.addEventListener("click", () => openDatabaseKey(item.key))
    list.append(button)
  }
  if (!databaseData.entries.length) {
    const empty = document.createElement("div")
    empty.className = "settings-card empty-state"
    empty.textContent = "没有找到匹配的键"
    list.append(empty)
  }
  pane.scrollTop = scrollTop
}

function updateDatabaseKeySelection() {
  $$(".database-key-item").forEach(button => {
    button.classList.toggle("active", button.dataset.key === currentDatabaseKey?.key)
  })
}

async function openDatabaseKey(key) {
  currentDatabaseKey = await action(() => api.getDatabaseKey(key))
  $("#databaseKeyName").value = currentDatabaseKey.key
  $("#databaseKeyType").value = currentDatabaseKey.type
  $("#databaseKeyTtl").value = currentDatabaseKey.ttl
  $("#databaseValueEditor").value = currentDatabaseKey.content ?? ""
  $("#databaseEditorTitle").textContent = currentDatabaseKey.key
  $("#databaseEditorHint").textContent = currentDatabaseKey.editable
    ? currentDatabaseKey.type === "string" ? "String 使用纯文本编辑" : `${currentDatabaseKey.type.toUpperCase()} 使用 JSON 格式编辑`
    : `${currentDatabaseKey.type} 类型暂时只读`
  for (const selector of ["#databaseKeyName", "#databaseKeyTtl", "#databaseValueEditor", "#saveDatabaseKeyButton"]) {
    $(selector).disabled = !currentDatabaseKey.editable
  }
  $("#databaseKeyType").disabled = true
  $("#deleteDatabaseKeyButton").disabled = false
  updateDatabaseKeySelection()
}

function newDatabaseKey() {
  const templates = {
    string: "",
    hash: "{\n  \"field\": \"value\"\n}",
    list: "[\n  \"item\"\n]",
    set: "[\n  \"member\"\n]",
    zset: "[\n  { \"value\": \"member\", \"score\": 1 }\n]",
  }
  currentDatabaseKey = { key: "", originalKey: null, type: "string", ttl: -1, editable: true }
  $("#databaseKeyName").value = ""
  $("#databaseKeyType").value = "string"
  $("#databaseKeyTtl").value = -1
  $("#databaseValueEditor").value = templates.string
  $("#databaseEditorTitle").textContent = "新建 Redis 键"
  $("#databaseEditorHint").textContent = "选择类型并填写内容"
  for (const selector of ["#databaseKeyName", "#databaseKeyType", "#databaseKeyTtl", "#databaseValueEditor", "#saveDatabaseKeyButton"]) {
    $(selector).disabled = false
  }
  $("#deleteDatabaseKeyButton").disabled = true
  $("#databaseKeyType").onchange = event => {
    $("#databaseValueEditor").value = templates[event.target.value]
  }
  $("#databaseKeyName").focus()
  renderDatabaseKeys()
}

function clearDatabaseEditor() {
  currentDatabaseKey = null
  $("#databaseKeyName").value = ""
  $("#databaseKeyTtl").value = -1
  $("#databaseValueEditor").value = ""
  $("#databaseEditorTitle").textContent = "选择一个键"
  $("#databaseEditorHint").textContent = "集合类型使用 JSON 格式编辑"
  for (const selector of ["#databaseKeyName", "#databaseKeyType", "#databaseKeyTtl", "#databaseValueEditor", "#saveDatabaseKeyButton", "#deleteDatabaseKeyButton"]) {
    $(selector).disabled = true
  }
}

async function refreshGuobaInfo() {
  guoba = await api.getGuobaInfo()
  $("#guobaNavItem").hidden = !guoba.installed
  renderGuobaPanel()
}

function renderGuobaPanel() {
  if (!guoba) return
  $("#guobaUrlText").textContent = guoba.url
  const available = guoba.installed
  $("#guobaOffline").hidden = available
  const webview = $("#guobaWebview")
  webview.hidden = !available
  if (available && webview.getAttribute("src") !== guoba.url) {
    webview.setAttribute("src", guoba.url)
  }
}

function renderBreadcrumbs() {
  const container = $("#fileBreadcrumb")
  container.replaceChildren()
  const segments = currentDirectory.split("/").filter(Boolean)
  const roots = [{ label: "Yunzai", path: "" }]
  let accumulated = ""
  for (const segment of segments) {
    accumulated = accumulated ? `${accumulated}/${segment}` : segment
    roots.push({ label: segment, path: accumulated })
  }
  roots.forEach((item, index) => {
    if (index) {
      const separator = document.createElement("span")
      separator.className = "crumb-separator"
      separator.innerHTML = appIcon("chevronRight", 13)
      container.append(separator)
    }
    const button = document.createElement("button")
    button.className = "crumb"
    button.textContent = item.label
    button.addEventListener("click", () => loadDirectory(item.path))
    container.append(button)
  })
}

async function loadDirectory(relativePath = "") {
  const result = await action(() => api.listDirectory(relativePath))
  currentDirectory = result.path
  renderBreadcrumbs()
  $("#fileUpButton").disabled = result.parent === null
  $("#fileUpButton").dataset.parent = result.parent ?? ""
  const list = $("#fileList")
  list.replaceChildren()
  for (const entry of result.entries) {
    const button = document.createElement("button")
    button.className = "file-item"
    button.innerHTML = `<span class="file-name-cell"><i class="file-icon"></i><span class="file-name"></span></span><small></small><small></small>`
    button.querySelector(".file-icon").innerHTML = appIcon(entry.directory ? "folder" : "file", 16)
    button.querySelector(".file-name").textContent = entry.name
    button.children[1].textContent = formatDate(entry.modifiedAt)
    button.children[2].textContent = entry.directory ? "" : formatSize(entry.size)
    button.addEventListener("click", () => entry.directory ? loadDirectory(entry.path) : entry.editable ? openFile(entry.path) : showToast("该文件不能在内置编辑器中打开"))
    list.append(button)
  }
}

async function openFile(relativePath) {
  currentFile = await action(() => api.readFile(relativePath))
  $("#fileTitle").textContent = currentFile.path
  $("#fileHint").textContent = `${formatSize(currentFile.size)} · ${formatDate(currentFile.modifiedAt)}`
  $("#fileEditor").value = currentFile.content
  $("#fileEditor").disabled = false
  $("#saveFileButton").disabled = false
  $("#renameFileButton").disabled = false
  $("#deleteFileButton").disabled = false
}

function clearFile() {
  currentFile = null
  $("#fileTitle").textContent = "选择文本文件"
  $("#fileHint").textContent = "最大支持 2 MB"
  $("#fileEditor").value = ""
  for (const id of ["fileEditor", "saveFileButton", "renameFileButton", "deleteFileButton"]) $(id.startsWith("#") ? id : `#${id}`).disabled = true
}

function bindEvents() {
  $$(".nav-item").forEach(item => item.addEventListener("click", () => switchPage(item.dataset.page)))
  $$("[data-open-page]").forEach(item => item.addEventListener("click", () => switchPage(item.dataset.openPage)))
  $("#minimizeWindow").addEventListener("click", api.minimizeWindow)
  $("#maximizeWindow").addEventListener("click", api.toggleMaximizeWindow)
  $("#closeWindow").addEventListener("click", api.closeWindow)
  $("#startButton").addEventListener("click", () => action(api.start, "Yunzai 已启动"))
  $("#stopButton").addEventListener("click", () => action(api.stop, "Yunzai 已停止"))
  $("#restartButton").addEventListener("click", () => action(api.restart, "Yunzai 已重启"))
  $("#openDirectoryButton").addEventListener("click", () => action(api.openDirectory))
  $("#installFrameworkButton").addEventListener("click", installYunzaiFramework)
  $("#installFrameworkSettingsButton").addEventListener("click", installYunzaiFramework)
  $("#chooseFrameworkPathButton").addEventListener("click", async () => {
    const result = await action(api.chooseFrameworkPath)
    if (!result) return
    ;({ settings, framework } = result)
    renderSettings()
  })
  $("#installDependenciesButton").addEventListener("click", async () => {
    environment = await action(api.installDependencies, "依赖安装完成，重启 Yunzai 后生效")
    renderEnvironment()
  })
  $("#refreshEnvironment").addEventListener("click", async () => { environment = await action(api.refreshEnvironment, "环境检测完成"); renderEnvironment() })
  $("#clearLogsButton").addEventListener("click", async () => { await api.clearLogs(); logs = []; $("#consoleOutput").replaceChildren(); $("#consoleCount").textContent = "0 条日志" })
  $("#consoleOutput").addEventListener("contextmenu", event => {
    event.preventDefault()
    const selection = window.getSelection()
    const selectedText = selection?.toString() || ""
    const line = event.target.closest(".log-line")
    void api.showConsoleMenu({
      selectedText,
      lineText: line?.innerText || "",
      allText: $("#consoleOutput").innerText,
    })
  })
  $("#commandForm").addEventListener("submit", async event => { event.preventDefault(); const input = $("#commandInput"); if (!input.value.trim()) return; await action(() => api.sendCommand(input.value.trim())); input.value = "" })
  $("#refreshBaseConfig").addEventListener("click", () => loadConfigs())
  $("#saveBaseConfig").addEventListener("click", async () => { currentBaseConfig = await action(() => api.saveConfig(currentBaseConfig.name, JSON.stringify(currentBaseConfig.data, null, 2)), "基础配置已保存"); await loadConfigs(); await openBaseConfig(currentBaseConfig.name) })
  $("#pluginConfigSearch").addEventListener("input", renderPluginConfigList)
  $("#savePluginWorkspace").addEventListener("click", async () => { currentPluginWorkspace = await action(() => api.savePluginWorkspace(currentPluginWorkspace.directory, currentPluginWorkspace.data), "插件配置已保存"); await openPluginWorkspace(currentPluginWorkspace.directory) })
  $("#refreshPluginsButton").addEventListener("click", loadPlugins)
  $("#installPluginButton").addEventListener("click", async () => {
    const input = $("#pluginUrlInput")
    if (!input.value.trim()) return showToast("请输入 Git 仓库地址")
    const button = $("#installPluginButton")
    button.disabled = true
    setButtonContent(button, "download", "安装中...")
    try {
      await action(() => api.installPlugin(input.value.trim()), "插件安装完成，重启 Yunzai 后生效")
      input.value = ""
      await loadPlugins()
      renderMarket()
    } finally {
      button.disabled = false
      setButtonContent(button, "download", "自定义安装")
    }
  })
  $("#refreshMarketButton").addEventListener("click", () => loadMarket(true))
  $("#marketSearch").addEventListener("input", renderMarket)
  $("#marketCategory").addEventListener("change", renderMarket)
  $$(".market-status-tabs button").forEach(button => button.addEventListener("click", () => {
    marketStatus = button.dataset.marketStatus
    $$(".market-status-tabs button").forEach(item => item.classList.toggle("active", item === button))
    renderMarket()
  }))
  $("#refreshJsPlugins").addEventListener("click", loadJsPlugins)
  $("#jsPluginSearch").addEventListener("input", renderJsPlugins)
  $("#refreshDependencies").addEventListener("click", loadDependencies)
  $("#dependencySearch").addEventListener("input", renderDependencies)
  $("#addDependencyButton").addEventListener("click", async () => {
    const input = $("#dependencyNameInput")
    if (!input.value.trim()) return showToast("请输入依赖名")
    const button = $("#addDependencyButton")
    button.disabled = true
    setButtonContent(button, "download", "安装中...")
    try {
      dependencies = await action(
        () => api.addDependency(input.value.trim()),
        "依赖安装完成，重启 Yunzai 后生效",
      )
      input.value = ""
      renderDependencies()
    } finally {
      button.disabled = false
      setButtonContent(button, "plus", "安装依赖")
    }
  })
  $("#searchDatabaseButton").addEventListener("click", loadDatabase)
  $("#refreshDatabaseButton").addEventListener("click", loadDatabase)
  $("#newDatabaseKeyButton").addEventListener("click", newDatabaseKey)
  $("#databaseSearch").addEventListener("keydown", event => {
    if (event.key === "Enter") loadDatabase()
  })
  $("#saveDatabaseKeyButton").addEventListener("click", async () => {
    currentDatabaseKey = await action(() => api.saveDatabaseKey({
      originalKey: currentDatabaseKey?.key || null,
      key: $("#databaseKeyName").value,
      type: $("#databaseKeyType").value,
      ttl: Number($("#databaseKeyTtl").value),
      content: $("#databaseValueEditor").value,
    }), "数据库键已保存")
    $("#databaseKeyType").onchange = null
    await loadDatabase()
    await openDatabaseKey(currentDatabaseKey.key)
  })
  $("#deleteDatabaseKeyButton").addEventListener("click", async () => {
    if (!currentDatabaseKey || !confirm(`确定删除 Redis 键 ${currentDatabaseKey.key}？此操作无法撤销。`)) return
    await action(() => api.deleteDatabaseKey(currentDatabaseKey.key), "数据库键已删除")
    clearDatabaseEditor()
    await loadDatabase()
  })
  $("#reloadGuobaButton").addEventListener("click", () => {
    const webview = $("#guobaWebview")
    if (webview.hidden) return showToast("请先启动 Yunzai")
    webview.reload()
  })
  $("#fileUpButton").addEventListener("click", () => loadDirectory($("#fileUpButton").dataset.parent))
  $("#refreshFilesButton").addEventListener("click", () => loadDirectory(currentDirectory))
  $("#newFileButton").addEventListener("click", async () => { const name = prompt("新文件名"); if (!name) return; const target = [currentDirectory, name].filter(Boolean).join("/"); await action(() => api.writeFile(target, ""), "文件已创建"); await loadDirectory(currentDirectory); await openFile(target) })
  $("#newFolderButton").addEventListener("click", async () => { const name = prompt("新文件夹名"); if (!name) return; await action(() => api.createDirectory([currentDirectory, name].filter(Boolean).join("/")), "文件夹已创建"); await loadDirectory(currentDirectory) })
  $("#saveFileButton").addEventListener("click", async () => { currentFile = await action(() => api.writeFile(currentFile.path, $("#fileEditor").value), "文件已保存") })
  $("#renameFileButton").addEventListener("click", async () => { const name = prompt("新名称", currentFile.path.split("/").pop()); if (!name) return; const next = await action(() => api.renameEntry(currentFile.path, name), "重命名完成"); await loadDirectory(currentDirectory); await openFile(next) })
  $("#deleteFileButton").addEventListener("click", async () => { if (!confirm(`确定将 ${currentFile.path} 移入回收目录？`)) return; await action(() => api.archiveEntry(currentFile.path), "已移入回收目录"); clearFile(); await loadDirectory(currentDirectory) })
  $("#themeColorInput").addEventListener("input", event => { $("#themeColorText").value = event.target.value; applyAppearance({ ...settings, themeColor: event.target.value, animations: $("#animationsInput").checked }) })
  $("#themeColorText").addEventListener("input", event => { if (/^#[0-9a-f]{6}$/i.test(event.target.value)) { $("#themeColorInput").value = event.target.value; applyAppearance({ ...settings, themeColor: event.target.value, animations: $("#animationsInput").checked }) } })
  $("#glassEnabledInput").addEventListener("change", event => {
    document.body.classList.toggle("glass", event.target.checked)
    $("#glassOpacityInput").disabled = !event.target.checked
    $("#glassOpacityField").classList.toggle("disabled", !event.target.checked)
    void api.previewAppearance({
      glassEnabled: event.target.checked,
      opacity: Number($("#glassOpacityInput").value) / 100,
    })
  })
  $("#glassOpacityInput").addEventListener("input", event => {
    $("#glassOpacityValue").textContent = `${event.target.value}%`
    void api.previewAppearance({
      glassEnabled: $("#glassEnabledInput").checked,
      opacity: Number(event.target.value) / 100,
    })
  })
  $("#animationsInput").addEventListener("change", event => document.body.classList.toggle("no-animations", !event.target.checked))
  $("#chooseDirectoryButton").addEventListener("click", async () => {
    const result = await action(api.chooseYunzai)
    if (!result) return
    ;({ settings, environment, state } = result)
    renderSettings(); renderEnvironment(); renderState()
    currentDirectory = ""; currentBaseConfig = null; currentPluginWorkspace = null
  })
  $("#saveSettingsButton").addEventListener("click", async () => {
    settings = await action(() => api.saveSettings({
      nodePath: $("#nodePathInput").value.trim() || "auto",
      autoStart: $("#autoStartInput").checked,
      autoRestart: $("#autoRestartInput").checked,
      openAtLogin: $("#openAtLoginInput").checked,
      minimizeToTray: $("#minimizeToTrayInput").checked,
      themeColor: $("#themeColorText").value,
      opacity: Number($("#glassOpacityInput").value) / 100,
      glassEnabled: $("#glassEnabledInput").checked,
      animations: $("#animationsInput").checked,
    }), "设置已保存")
    renderSettings()
  })
}

async function init() {
  const initial = await api.init()
  ;({ settings, state, environment, framework, guoba } = initial)
  applySystemTheme(initial.darkMode)
  renderSettings()
  renderState()
  renderEnvironment()
  appendLogs(initial.logs)
  decorateStaticButtons()
  $("#guobaNavItem").hidden = !guoba.installed
  renderGuobaPanel()
  bindEvents()
  api.onState(next => { state = next; renderState() })
  api.onLogs(appendLogs)
  api.onThemeChanged(applySystemTheme)
}

init().catch(error => showToast(error.message || String(error)))
