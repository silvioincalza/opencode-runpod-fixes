import { test } from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

const SRC = path.resolve(import.meta.dirname, "../src")
const ROOT = path.resolve(SRC, "..")
const COMPOSITION_ROOT = "src/adapters/driving/opencode/plugin.ts"

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

function importsOf(file: string): string[] {
  const specs: string[] = []
  for (const match of readFileSync(file, "utf8").matchAll(/(?:from|import)\s+"([^"]+)"/g)) specs.push(match[1]!)
  return specs
}

const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/")
const isLocal = (spec: string) => spec.startsWith("./") || spec.startsWith("../")
const target = (file: string, spec: string) => rel(path.resolve(path.dirname(file), spec))

test("core imports only core and node builtins", () => {
  for (const file of walk(path.join(SRC, "core"))) {
    for (const spec of importsOf(file)) {
      if (isLocal(spec)) assert.ok(target(file, spec).startsWith("src/core/"), `${rel(file)} imports ${spec}`)
      else assert.ok(spec.startsWith("node:"), `${rel(file)} imports package ${spec}`)
    }
  }
})

test("driven adapters import only core and their own folder", () => {
  for (const file of walk(path.join(SRC, "adapters", "driven"))) {
    const own = rel(file).split("/").slice(0, 4).join("/") // src/adapters/driven/<name>
    for (const spec of importsOf(file)) {
      if (!isLocal(spec)) continue
      const t = target(file, spec)
      assert.ok(t.startsWith("src/core/") || t.startsWith(`${own}/`), `${rel(file)} imports ${spec}`)
    }
  }
})

test("driving adapters import core and driving only; the composition root may import driven adapters", () => {
  for (const file of walk(path.join(SRC, "adapters", "driving"))) {
    if (rel(file) === COMPOSITION_ROOT) continue
    for (const spec of importsOf(file)) {
      if (!isLocal(spec)) continue
      const t = target(file, spec)
      assert.ok(t.startsWith("src/core/") || t.startsWith("src/adapters/driving/"), `${rel(file)} imports ${spec}`)
    }
  }
})

test("domain, ports and application directories exist", () => {
  for (const dir of ["core/domain", "core/ports", "core/application", "adapters/driven", "adapters/driving"]) {
    assert.ok(statSync(path.join(SRC, dir)).isDirectory(), dir)
  }
})
