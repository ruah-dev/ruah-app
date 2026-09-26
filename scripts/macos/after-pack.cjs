// scripts/macos/after-pack.cjs — electron-builder afterPack (before signing):
// file modes the tarballs get wrong. node-pty 1.1.0 ships prebuilds/*/spawn-helper
// without the execute bit (posix_spawnp then fails on every terminal), and the
// daemon cannot chmod inside an installed, signed app. Also: the third-party
// notices ship with every build (their licenses require it for the bundled code
// and fonts), or the build fails.
const fs = require("node:fs");
const path = require("node:path");

function chmodExecutable(file) {
  try {
    if (fs.statSync(file).isFile()) {
      fs.chmodSync(file, 0o755);
      return true;
    }
  } catch {
    // not there
  }
  return false;
}

function spawnHelpers(appRoot) {
  const ptyDir = path.join(appRoot, "node_modules", "node-pty");
  const out = [];
  for (const sub of ["build/Release", "build/Debug"]) out.push(path.join(ptyDir, sub, "spawn-helper"));
  try {
    for (const entry of fs.readdirSync(path.join(ptyDir, "prebuilds"))) out.push(path.join(ptyDir, "prebuilds", entry, "spawn-helper"));
  } catch {
    // no prebuilds
  }
  return out;
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const bundle = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const resources = path.join(bundle, "Contents", "Resources");
  const fixed = spawnHelpers(path.join(resources, "app")).filter(chmodExecutable);
  if (fixed.length === 0) throw new Error("after-pack: node-pty's spawn-helper is missing from the app");
  if (!chmodExecutable(path.join(resources, "bin", "ruah-app"))) throw new Error("after-pack: Resources/bin/ruah-app is missing");
  checkNotices(resources);
  console.log(`  • after-pack  made executable: ${fixed.map((f) => path.relative(bundle, f)).join(", ")}, Contents/Resources/bin/ruah-app`);
};

/** The notices the bundled T3 Code, shadcn/ui and font files need (THIRD_PARTY_NOTICES.md). */
const REQUIRED_NOTICES = ["Copyright (c) 2026 T3 Tools Inc.", "Copyright (c) 2023 shadcn", "SIL OPEN FONT LICENSE Version 1.1", "Permission is hereby granted"];

function checkNotices(resources) {
  let text;
  try {
    text = fs.readFileSync(path.join(resources, "THIRD_PARTY_NOTICES.md"), "utf8");
  } catch {
    throw new Error("after-pack: Resources/THIRD_PARTY_NOTICES.md is missing");
  }
  const missing = REQUIRED_NOTICES.filter((n) => !text.includes(n));
  if (missing.length > 0) throw new Error(`after-pack: Resources/THIRD_PARTY_NOTICES.md lacks: ${missing.join("; ")}`);
}

exports.spawnHelpers = spawnHelpers;
exports.checkNotices = checkNotices;
