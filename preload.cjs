const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("yunzaiDesktop", {
  init: () => ipcRenderer.invoke("app:init"),
  installFramework: () => ipcRenderer.invoke("framework:install"),
  chooseFrameworkPath: () => ipcRenderer.invoke("settings:choose-framework-path"),
  chooseYunzai: () => ipcRenderer.invoke("settings:choose-yunzai"),
  saveSettings: patch => ipcRenderer.invoke("settings:save", patch),
  previewAppearance: value => ipcRenderer.invoke("settings:preview-appearance", value),
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximizeWindow: () => ipcRenderer.invoke("window:toggle-maximize"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
  refreshEnvironment: () => ipcRenderer.invoke("environment:refresh"),
  start: () => ipcRenderer.invoke("yunzai:start"),
  stop: () => ipcRenderer.invoke("yunzai:stop"),
  restart: () => ipcRenderer.invoke("yunzai:restart"),
  sendCommand: command => ipcRenderer.invoke("yunzai:command", command),
  installDependencies: () => ipcRenderer.invoke("yunzai:install-dependencies"),
  clearLogs: () => ipcRenderer.invoke("yunzai:clear-logs"),
  showConsoleMenu: payload => ipcRenderer.invoke("console:context-menu", payload),
  openDirectory: () => ipcRenderer.invoke("yunzai:open-directory"),
  listConfigs: () => ipcRenderer.invoke("config:list"),
  getConfig: name => ipcRenderer.invoke("config:get", name),
  saveConfig: (name, content) => ipcRenderer.invoke("config:save", { name, content }),
  listPlugins: () => ipcRenderer.invoke("plugins:list"),
  installPlugin: url => ipcRenderer.invoke("plugins:install", url),
  openPluginRepository: url => ipcRenderer.invoke("plugins:open-repository", url),
  removePlugin: name => ipcRenderer.invoke("plugins:remove", name),
  listPluginConfigs: directory => ipcRenderer.invoke("plugins:config-list", directory),
  getPluginConfig: (directory, target) => ipcRenderer.invoke("plugins:config-get", { directory, target }),
  savePluginConfig: (directory, target, content) =>
    ipcRenderer.invoke("plugins:config-save", { directory, target, content }),
  getPluginWorkspace: directory => ipcRenderer.invoke("plugins:workspace-get", directory),
  savePluginWorkspace: (directory, data) =>
    ipcRenderer.invoke("plugins:workspace-save", { directory, data }),
  listJsPlugins: () => ipcRenderer.invoke("js-plugins:list"),
  toggleJsPlugin: (fileName, enabled) =>
    ipcRenderer.invoke("js-plugins:toggle", { fileName, enabled }),
  listDependencies: () => ipcRenderer.invoke("dependencies:list"),
  addDependency: specifier => ipcRenderer.invoke("dependencies:add", specifier),
  listDatabaseKeys: pattern => ipcRenderer.invoke("database:list", pattern),
  getDatabaseKey: key => ipcRenderer.invoke("database:get", key),
  saveDatabaseKey: payload => ipcRenderer.invoke("database:save", payload),
  deleteDatabaseKey: key => ipcRenderer.invoke("database:delete", key),
  getGuobaInfo: () => ipcRenderer.invoke("guoba:info"),
  listMarket: force => ipcRenderer.invoke("market:list", Boolean(force)),
  listDirectory: relativePath => ipcRenderer.invoke("files:list", relativePath),
  readFile: relativePath => ipcRenderer.invoke("files:read", relativePath),
  writeFile: (relativePath, content) => ipcRenderer.invoke("files:write", { relativePath, content }),
  createDirectory: relativePath => ipcRenderer.invoke("files:mkdir", relativePath),
  renameEntry: (relativePath, newName) => ipcRenderer.invoke("files:rename", { relativePath, newName }),
  archiveEntry: relativePath => ipcRenderer.invoke("files:archive", relativePath),
  onState(callback) {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on("yunzai:state", listener)
    return () => ipcRenderer.removeListener("yunzai:state", listener)
  },
  onLogs(callback) {
    const listener = (_event, entries) => callback(entries)
    ipcRenderer.on("yunzai:logs", listener)
    return () => ipcRenderer.removeListener("yunzai:logs", listener)
  },
  onThemeChanged(callback) {
    const listener = (_event, darkMode) => callback(darkMode)
    ipcRenderer.on("theme:changed", listener)
    return () => ipcRenderer.removeListener("theme:changed", listener)
  },
})
