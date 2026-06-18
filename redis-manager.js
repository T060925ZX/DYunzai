import { createClient } from "redis"

const supportedTypes = new Set(["string", "hash", "list", "set", "zset"])

export class RedisManager {
  constructor(getConfig, ensureServer) {
    this.getConfig = getConfig
    this.ensureServer = ensureServer
  }

  connectionOptions() {
    const config = this.getConfig()
    return {
      database: Math.max(0, Number(config.db) || 0),
      username: config.username || undefined,
      password: config.password || undefined,
      socket: {
        host: config.host || "127.0.0.1",
        port: Number(config.port) || 6379,
        connectTimeout: 3000,
        reconnectStrategy: false,
      },
    }
  }

  async use(task) {
    await this.ensureServer()
    const client = createClient(this.connectionOptions())
    client.on("error", () => {})
    try {
      await client.connect()
      return await task(client)
    } finally {
      if (client.isOpen) await client.quit().catch(() => client.disconnect())
    }
  }

  async overview(pattern = "*") {
    return this.use(async client => {
      const keys = []
      let cursor = 0
      const match = String(pattern || "*").trim() || "*"
      do {
        const result = await client.scan(cursor, { MATCH: match, COUNT: 120 })
        cursor = Number(result.cursor)
        keys.push(...result.keys)
      } while (cursor !== 0 && keys.length < 500)

      const limited = keys.slice(0, 500)
      const entries = await Promise.all(
        limited.map(async key => ({
          key,
          type: await client.type(key),
          ttl: await client.ttl(key),
        })),
      )
      const config = this.getConfig()
      return {
        entries: entries.sort((left, right) => left.key.localeCompare(right.key, "zh-CN")),
        total: await client.dbSize(),
        truncated: keys.length > limited.length || cursor !== 0,
        connection: {
          host: config.host || "127.0.0.1",
          port: Number(config.port) || 6379,
          db: Math.max(0, Number(config.db) || 0),
        },
      }
    })
  }

  async get(key) {
    return this.use(async client => {
      const type = await client.type(key)
      if (type === "none") throw new Error("该键不存在或已被删除")
      const ttl = await client.ttl(key)
      let value
      if (type === "string") value = await client.get(key)
      else if (type === "hash") value = await client.hGetAll(key)
      else if (type === "list") value = await client.lRange(key, 0, -1)
      else if (type === "set") value = await client.sMembers(key)
      else if (type === "zset") value = await client.zRangeWithScores(key, 0, -1)
      else value = null
      return {
        key,
        type,
        ttl,
        editable: supportedTypes.has(type),
        content: type === "string" ? value ?? "" : JSON.stringify(value, null, 2),
      }
    })
  }

  async save({ key, originalKey, type, content, ttl }) {
    const target = String(key || "").trim()
    if (!target) throw new Error("键名不能为空")
    if (!supportedTypes.has(type)) throw new Error(`暂不支持编辑 ${type} 类型`)
    return this.use(async client => {
      const parsedTtl = Number(ttl)
      const transaction = client.multi()
      if (originalKey && originalKey !== target) transaction.del(originalKey)
      transaction.del(target)

      if (type === "string") transaction.set(target, String(content ?? ""))
      if (type === "hash") {
        const value = JSON.parse(content)
        if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Hash 内容必须是 JSON 对象")
        const entries = Object.entries(value)
        if (!entries.length) throw new Error("Hash 至少需要一个字段")
        transaction.hSet(target, Object.fromEntries(entries.map(([name, item]) => [name, String(item)])))
      }
      if (type === "list" || type === "set") {
        const value = JSON.parse(content)
        if (!Array.isArray(value) || !value.length) throw new Error(`${type} 内容必须是非空 JSON 数组`)
        const items = value.map(item => String(item))
        if (type === "list") transaction.rPush(target, items)
        else transaction.sAdd(target, items)
      }
      if (type === "zset") {
        const value = JSON.parse(content)
        if (!Array.isArray(value) || !value.length) throw new Error("ZSet 内容必须是非空 JSON 数组")
        const members = value.map(item => {
          if (!item || typeof item !== "object" || !Number.isFinite(Number(item.score))) {
            throw new Error("ZSet 每项必须包含 value 和数字 score")
          }
          return { value: String(item.value ?? item.member ?? ""), score: Number(item.score) }
        })
        transaction.zAdd(target, members)
      }
      if (parsedTtl > 0) transaction.expire(target, Math.floor(parsedTtl))
      await transaction.exec()
      return this.readWithClient(client, target)
    })
  }

  async readWithClient(client, key) {
    const type = await client.type(key)
    const ttl = await client.ttl(key)
    let value
    if (type === "string") value = await client.get(key)
    else if (type === "hash") value = await client.hGetAll(key)
    else if (type === "list") value = await client.lRange(key, 0, -1)
    else if (type === "set") value = await client.sMembers(key)
    else if (type === "zset") value = await client.zRangeWithScores(key, 0, -1)
    return {
      key,
      type,
      ttl,
      editable: supportedTypes.has(type),
      content: type === "string" ? value ?? "" : JSON.stringify(value, null, 2),
    }
  }

  async delete(key) {
    return this.use(async client => {
      await client.del(key)
      return true
    })
  }
}
