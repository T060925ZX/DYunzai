import fs from "node:fs"
import path from "node:path"
import { parse } from "acorn"

const unsupported = Symbol("unsupported")

function resolveModule(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null
  const base = path.resolve(path.dirname(fromFile), specifier)
  for (const candidate of [base, `${base}.js`, `${base}.mjs`, path.join(base, "index.js")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  return null
}

function propertyName(node, env, cache) {
  if (!node.computed && node.key.type === "Identifier") return node.key.name
  const value = evaluate(node.key, env, cache)
  return value === unsupported ? null : String(value)
}

function evaluate(node, env, cache) {
  if (!node) return unsupported
  switch (node.type) {
    case "Literal":
      return node.value
    case "Identifier":
      if (node.name === "undefined") return undefined
      return env.has(node.name) ? env.get(node.name) : unsupported
    case "TemplateLiteral": {
      if (node.expressions.length) return unsupported
      return node.quasis.map(item => item.value.cooked).join("")
    }
    case "UnaryExpression": {
      const value = evaluate(node.argument, env, cache)
      if (value === unsupported) return unsupported
      if (node.operator === "-") return -value
      if (node.operator === "+") return +value
      if (node.operator === "!") return !value
      return unsupported
    }
    case "ArrayExpression": {
      const result = []
      for (const item of node.elements) {
        if (!item) continue
        if (item.type === "SpreadElement") {
          const value = evaluate(item.argument, env, cache)
          if (Array.isArray(value)) result.push(...value)
          continue
        }
        const value = evaluate(item, env, cache)
        if (value !== unsupported) result.push(value)
      }
      return result
    }
    case "ObjectExpression": {
      const result = {}
      for (const property of node.properties) {
        if (property.type === "SpreadElement") {
          const value = evaluate(property.argument, env, cache)
          if (value && value !== unsupported && typeof value === "object") Object.assign(result, value)
          continue
        }
        if (property.kind !== "init") continue
        const key = propertyName(property, env, cache)
        const value = evaluate(property.value, env, cache)
        if (key !== null && value !== unsupported) result[key] = value
      }
      return result
    }
    case "MemberExpression": {
      const object = evaluate(node.object, env, cache)
      const key = node.computed ? evaluate(node.property, env, cache) : node.property.name
      if (!object || object === unsupported || key === unsupported) return unsupported
      return object[key] ?? unsupported
    }
    default:
      return unsupported
  }
}

function functionReturn(node, env, cache) {
  const body = node.body?.body || []
  const returned = body.find(statement => statement.type === "ReturnStatement")
  return returned ? evaluate(returned.argument, env, cache) : unsupported
}

function readModule(file, cache = new Map()) {
  const absolute = path.resolve(file)
  if (cache.has(absolute)) return cache.get(absolute)
  const module = { exports: {}, env: new Map() }
  cache.set(absolute, module)
  const source = fs.readFileSync(absolute, "utf8")
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" })

  for (const node of ast.body) {
    if (node.type !== "ImportDeclaration") continue
    const target = resolveModule(absolute, node.source.value)
    if (!target) continue
    const imported = readModule(target, cache).exports
    for (const specifier of node.specifiers) {
      if (specifier.type === "ImportDefaultSpecifier") module.env.set(specifier.local.name, imported.default)
      else if (specifier.type === "ImportNamespaceSpecifier") module.env.set(specifier.local.name, imported)
      else module.env.set(specifier.local.name, imported[specifier.imported.name])
    }
  }

  for (const node of ast.body) {
    const declaration = node.type === "ExportNamedDeclaration" ? node.declaration : node
    if (!declaration) continue
    if (declaration.type === "VariableDeclaration") {
      for (const item of declaration.declarations) {
        if (item.id.type !== "Identifier") continue
        const value = evaluate(item.init, module.env, cache)
        if (value !== unsupported) module.env.set(item.id.name, value)
      }
    } else if (declaration.type === "FunctionDeclaration" && declaration.id) {
      module.env.set(declaration.id.name, { __function: declaration, __env: module.env })
    }
  }

  for (const node of ast.body) {
    if (node.type === "ExportDefaultDeclaration") {
      const value = evaluate(node.declaration, module.env, cache)
      if (value !== unsupported) module.exports.default = value
    }
    if (node.type !== "ExportNamedDeclaration") continue
    if (node.source) {
      const target = resolveModule(absolute, node.source.value)
      if (!target) continue
      const imported = readModule(target, cache).exports
      for (const specifier of node.specifiers) {
        module.exports[specifier.exported.name] = imported[specifier.local.name]
      }
    }
    if (node.declaration?.type === "VariableDeclaration") {
      for (const item of node.declaration.declarations) {
        if (item.id.type === "Identifier") module.exports[item.id.name] = module.env.get(item.id.name)
      }
    }
    if (node.declaration?.type === "FunctionDeclaration") {
      const name = node.declaration.id.name
      module.exports[name] = module.env.get(name)
    }
    for (const specifier of node.specifiers || []) {
      module.exports[specifier.exported.name] = module.env.get(specifier.local.name)
    }
  }
  return module
}

export function parseGuobaSupport(file) {
  try {
    const source = fs.readFileSync(file, "utf8")
    const forwarded = source.match(/export\s*\{\s*supportGuoba\s*\}\s*from\s*["']([^"']+)["']/)
    if (forwarded) {
      const target = resolveModule(file, forwarded[1])
      if (target) return parseGuobaSupport(target)
    }
    const module = readModule(file)
    const support = module.exports.supportGuoba || module.exports.default
    const result =
      support?.__function ? functionReturn(support.__function, support.__env, new Map()) : support
    if (!result || result === unsupported || typeof result !== "object") return null
    const schemas = result.configInfo?.schemas
    const schemaGroups = result.configInfo?.schemaGroups
    const normalizeSchemas = value =>
      Array.isArray(value)
        ? value.filter(item => item && typeof item === "object").map(item => ({
            field: item.field,
            label: item.label,
            component: item.component,
            required: Boolean(item.required),
            helpMessage: item.helpMessage,
            bottomHelpMessage: item.bottomHelpMessage,
            componentProps: item.componentProps || {},
          }))
        : []
    return {
      pluginInfo: result.pluginInfo || {},
      schemas: normalizeSchemas(schemas),
      schemaGroups: Array.isArray(schemaGroups)
        ? schemaGroups.map((group, index) => ({
            key: group.key || group.name || `group-${index + 1}`,
            label: group.label || group.title || group.name || `分类 ${index + 1}`,
            schemas: normalizeSchemas(group.schemas || group.items),
          }))
        : [],
    }
  } catch {
    return null
  }
}
