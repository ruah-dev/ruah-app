// electron-builder.config.cjs — `pnpm dist` → release/Ruah-<version>-arm64.dmg
// (and release/mac-arm64/Ruah.app). README "Package" has the signing story.
//
// Why electron-builder (not Electron Forge): one declarative config does the
// .app, the styled .dmg, ad-hoc or Developer ID signing and notarization, and
// it collects production node_modules straight from pnpm; Forge needs a plugin
// per step and its pnpm support means hoisting the whole tree.
//
// Why asar is off: the daemon is a plain Node program (dist/cli.js, run by the
// app binary as Node) that spawns binaries from its node_modules — Claude's
// native CLI, node-pty's spawn-helper, itself for the MCP server. Inside an
// asar every one of those would need unpacking and path rewriting; a local app
// gains nothing from the archive.
//
// Why no native rebuild: node-pty 1.1.0 is an N-API addon with a darwin-arm64
// prebuild, ABI-stable across Node and Electron. scripts/macos/after-sign.cjs
// proves it on every build: the packaged binary, as Node, opens a real pty.

const { macSigning } = require("./scripts/macos/signing.cjs");

const signing = macSigning();

/** @type {import("electron-builder").Configuration} */
const config = {
  appId: "dev.ruah.app",
  productName: "Ruah",
  copyright: "© 2026 Ruah",
  directories: { output: "release", buildResources: "electron/build" },
  artifactName: "Ruah-${version}-${arch}.${ext}",
  files: [
    "package.json",
    "electron/**/*",
    "!electron/build/**",
    "!electron/bin/**",
    "dist/**/*",
    "viewer/**/*",
    // node_modules come from pnpm's production tree; drop what never runs on a Mac.
    "!**/node_modules/node-pty/{src,deps,third_party,scripts}/**",
    "!**/node_modules/node-pty/binding.gyp",
    "!**/node_modules/node-pty/prebuilds/{win32-*,darwin-x64}/**", // arm64-only app
    "!**/node_modules/**/*.map",
  ],
  // `ruah-app` on the app's own runtime (README: put it on PATH).
  extraResources: [{ from: "electron/bin", to: "bin", filter: ["ruah-app"] }],
  asar: false,
  npmRebuild: false,
  electronLanguages: ["en"],
  afterPack: "./scripts/macos/after-pack.cjs",
  afterSign: "./scripts/macos/after-sign.cjs",
  mac: {
    target: [{ target: "dmg", arch: ["arm64"] }],
    icon: "electron/assets/icon.icns",
    category: "public.app-category.developer-tools",
    darkModeSupport: true,
    identity: signing.identity,
    hardenedRuntime: signing.hardenedRuntime,
    gatekeeperAssess: false,
    entitlements: "electron/build/entitlements.mac.plist",
    entitlementsInherit: "electron/build/entitlements.mac.plist",
    notarize: signing.notarize,
    // Claude's native CLI (bundled by the Claude Agent SDK) keeps Anthropic's own
    // Developer ID signature and entitlements; re-signing it would drop them.
    signIgnore: ["node_modules/@anthropic-ai/claude-agent-sdk-darwin-[^/]+/claude$"],
    extendInfo: {
      // `open -a Ruah <folder>`, folders dropped on the Dock icon, Finder "Open With".
      // Alternate: Ruah never becomes the default app for folders.
      CFBundleDocumentTypes: [
        { CFBundleTypeName: "Folder", CFBundleTypeRole: "Viewer", LSHandlerRank: "Alternate", LSItemContentTypes: ["public.folder"] },
      ],
      NSDocumentsFolderUsageDescription: "Ruah maps the projects you open and lets coding agents work on them.",
      NSDesktopFolderUsageDescription: "Ruah maps the projects you open and lets coding agents work on them.",
      NSDownloadsFolderUsageDescription: "Ruah reads projects and saves exports where you choose.",
      NSRemovableVolumesUsageDescription: "Ruah maps projects on external drives when you open them.",
      NSNetworkVolumesUsageDescription: "Ruah maps projects on network volumes when you open them.",
    },
  },
  dmg: {
    title: "Ruah ${version}",
    background: "electron/build/dmg-background.tiff",
    iconSize: 96,
    window: { width: 540, height: 380 },
    contents: [
      { x: 140, y: 196, type: "file" },
      { x: 400, y: 196, type: "link", path: "/Applications" },
    ],
    format: "ULFO",
    writeUpdateInfo: false,
  },
};

module.exports = config;
