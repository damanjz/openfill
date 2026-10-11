// Build two release files (no dependencies, uses Node's zlib):
//   dist/openfill-<version>.ccx          zip of plugin/ with manifest.json at the root (Creative Cloud double-click)
//   dist/openfill-<version>-windows.zip  OpenFill/ folder with the plugin, installer and "Install OpenFill.bat"
//                                        for Photoshop without the Creative Cloud app

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "plugin");
const DIST = path.join(ROOT, "dist");

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return ~c >>> 0;
}

function walk(dir, base = dir) {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  // Fixed DOS timestamp so builds are reproducible: 2026-01-01 00:00
  const time = 0;
  const date = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(useDeflate ? 8 : 0, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cenBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cenBuf, end]);
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, "manifest.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  if (manifest.version !== pkg.version) {
    throw new Error(`Version mismatch: manifest ${manifest.version} vs package.json ${pkg.version}`);
  }
  // The in-Photoshop self-test is a developer tool; release builds leave it out.
  const DEV_ONLY = new Set(["src/selftest.js"]);
  const files = walk(SRC)
    .filter((name) => !DEV_ONLY.has(name))
    .map((name) => ({ name, data: fs.readFileSync(path.join(SRC, name)) }));
  if (!files.some((f) => f.name === "manifest.json")) throw new Error("manifest.json missing");
  const ccx = zip(files);

  const INST = path.join(ROOT, "installer");
  const manual = [
    ...files.map((f) => ({ name: `OpenFill/plugin/${f.name}`, data: f.data })),
    { name: "OpenFill/Install OpenFill.bat", data: fs.readFileSync(path.join(INST, "Install OpenFill.bat")) },
    { name: "OpenFill/Uninstall OpenFill.bat", data: fs.readFileSync(path.join(INST, "Uninstall OpenFill.bat")) },
    { name: "OpenFill/installer/install.ps1", data: fs.readFileSync(path.join(INST, "install.ps1")) },
    { name: "OpenFill/installer/uninstall.ps1", data: fs.readFileSync(path.join(INST, "uninstall.ps1")) },
    { name: "OpenFill/README.md", data: fs.readFileSync(path.join(ROOT, "README.md")) },
    { name: "OpenFill/LICENSE", data: fs.readFileSync(path.join(ROOT, "LICENSE")) },
  ];
  const winZip = zip(manual);

  fs.mkdirSync(DIST, { recursive: true });
  for (const f of fs.readdirSync(DIST)) fs.rmSync(path.join(DIST, f));
  const base = `openfill-${manifest.version}`;
  fs.writeFileSync(path.join(DIST, `${base}.ccx`), ccx);
  fs.writeFileSync(path.join(DIST, `${base}-windows.zip`), winZip);
  console.log(`Built dist/${base}.ccx (${(ccx.length / 1024).toFixed(1)} KB) and dist/${base}-windows.zip (${(winZip.length / 1024).toFixed(1)} KB), ${files.length} plugin files`);
}

if (require.main === module) main();
module.exports = { zip, walk };
