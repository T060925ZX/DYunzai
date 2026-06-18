import fs from "node:fs"
import path from "node:path"

const cacheLifetime = 6 * 60 * 60 * 1000
const sources = [
  {
    base: "https://raw.githubusercontent.com/yhArcadia/Yunzai-Bot-plugins-index/main",
    site: "GitHub",
  },
  {
    base: "https://gitee.com/yhArcadia/Yunzai-Bot-plugins-index/raw/main",
    site: "Gitee",
  },
]
const files = [
  ["README.md", "推荐插件"],
  ["Function-Plugin.md", "功能插件"],
  ["Game-Plugin.md", "游戏插件"],
]

function cleanCell(value) {
  return value
    .trim()
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
}

function parseLink(cell) {
  const match = cell.match(/\[([^\]]+)]\((https?:\/\/[^)]+)\)/i)
  if (match) return { name: cleanCell(match[1]), url: match[2].trim() }
  const url = cell.match(/https?:\/\/[^\s|)]+/i)?.[0]
  return { name: cleanCell(cell.replace(/https?:\/\/[^\s|)]+/i, "")), url: url || "" }
}

function parseMarkdown(markdown, category) {
  const plugins = []
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue
    const cells = line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map(cleanCell)
    if (cells.length < 3 || cells.every(cell => /^:?-+:?$/.test(cell))) continue
    const link = parseLink(cells[0])
    if (!link.url || /^(插件名|名称|plugin name)$/i.test(link.name)) continue
    plugins.push({
      name: link.name || link.url.split("/").filter(Boolean).pop()?.replace(/\.git$/i, "") || "未命名插件",
      url: link.url,
      author: cells[1] || "",
      description: cells.slice(2).join(" · "),
      category,
    })
  }
  return plugins
}

export class MarketManager {
  constructor(cacheDirectory) {
    this.cacheFile = path.join(cacheDirectory, "plugin-market.json")
  }

  readCache() {
    try {
      return JSON.parse(fs.readFileSync(this.cacheFile, "utf8"))
    } catch {
      return null
    }
  }

  writeCache(data) {
    fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true })
    fs.writeFileSync(this.cacheFile, JSON.stringify(data, null, 2), "utf8")
  }

  async list(force = false) {
    const cached = this.readCache()
    if (!force && cached && Date.now() - cached.updatedAt < cacheLifetime) return cached

    let lastError
    for (const source of sources) {
      try {
        const documents = await Promise.all(
          files.map(async ([file, category]) => {
            const response = await fetch(`${source.base}/${file}`, {
              signal: AbortSignal.timeout(12000),
              headers: { "User-Agent": "Yunzai-Desktop" },
            })
            if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
            return { category, markdown: await response.text() }
          }),
        )
        const deduplicated = new Map()
        for (const document of documents) {
          for (const plugin of parseMarkdown(document.markdown, document.category)) {
            deduplicated.set(plugin.url.toLowerCase().replace(/\.git$/, ""), plugin)
          }
        }
        const result = {
          updatedAt: Date.now(),
          source: source.site,
          plugins: [...deduplicated.values()].sort(
            (a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name),
          ),
        }
        this.writeCache(result)
        return result
      } catch (error) {
        lastError = error
      }
    }
    if (cached) return { ...cached, stale: true, error: lastError?.message }
    throw new Error(`插件市场加载失败：${lastError?.message || "网络不可用"}`)
  }
}
