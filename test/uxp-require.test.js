// UXP's module loader resolves "./file" and "./file.js" but not "./folder" (no index.js lookup),
// and it has no node_modules. Found the hard way on Photoshop 27.10, 2026-10-12.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const PLUGIN = path.join(__dirname, "..", "plugin");
const HOST_MODULES = new Set(["photoshop", "uxp", "os", "fs"]);

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? jsFiles(full) : e.name.endsWith(".js") ? [full] : [];
  });
}

test("every require in the plugin is a host module or resolves to a file (not a folder)", () => {
  const problems = [];
  for (const file of jsFiles(PLUGIN)) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
      const spec = m[1];
      if (HOST_MODULES.has(spec)) continue;
      if (!spec.startsWith(".")) {
        problems.push(`${path.relative(PLUGIN, file)}: "${spec}" is not a relative path (no node_modules in UXP)`);
        continue;
      }
      const base = path.resolve(path.dirname(file), spec);
      const ok = [base, `${base}.js`].some((p) => fs.existsSync(p) && fs.statSync(p).isFile());
      if (!ok) problems.push(`${path.relative(PLUGIN, file)}: "${spec}" does not resolve to a file`);
    }
  }
  assert.deepEqual(problems, []);
});
