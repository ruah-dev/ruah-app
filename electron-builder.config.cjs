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
//
// Fuses: RunAsNode must stay on — the daemon is this binary as Node. That also
// lets any local process run its own JS under Ruah's identity and with the
// folder access macOS granted Ruah (README "Security"; the way out is a separate
// helper runtime for the daemon). What the daemon does not need is off:
// NODE_OPTIONS / NODE_EXTRA_CA_CERTS, --inspect / SIGUSR1, and file:// pages'
// extra privileges (the window only loads the daemon's http origin).

const { existsSync } = require("node:fs");
const path = require("node:path");
const { macSigning } = require("./scripts/macos/signing.cjs");
const { macFlavor } = require("./scripts/macos/flavor.cjs");
const { buildStamp } = require("./scripts/macos/build-stamp.cjs");

const signing = macSigning();
const flavor = macFlavor();
const stamp = buildStamp(__dirname);
const extraMetadata = { ...(flavor.extraMetadata ?? {}), ...(stamp !== undefined ? { ruahBuild: stamp } : {}) };

// Electron's Info.plist asks for camera, microphone and Bluetooth "for this app". Ruah
// itself uses none of them, but agents and the integrated terminal run as its children:
// macOS attributes their requests to Ruah and stops a process whose app has no usage
// string, so the keys stay — saying what they are for.
const CHILD_PROGRAMS = "Programs you run in Ruah's terminal or through its coding agents";

/** @type {import("electron-builder").Configuration} */
const config = {
  appId: flavor.appId,
  productName: flavor.productName,
  copyright: "© 2026 Ruah",
  directories: { output: "release", buildResources: "electron/build" },
  artifactName: flavor.artifactName,
  ...(Object.keys(extraMetadata).length > 0 ? { extraMetadata } : {}),
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
  extraResources: [
    // `ruah-app` on the app's own runtime (README: put it on PATH).
    { from: "electron/bin", to: "bin", filter: ["ruah-app"] },
    // The bundlers drop the source files' notice headers, so the licenses of the code and
    // fonts adapted into dist/ and viewer/ (T3 Code and shadcn/ui: MIT; Jura, Geist Mono:
    // OFL 1.1) travel as Contents/Resources/THIRD_PARTY_NOTICES.md. afterPack checks it.
    { from: "THIRD_PARTY_NOTICES.md", to: "THIRD_PARTY_NOTICES.md" },
    // Ruah's own license, once the repository has one.
    ...(existsSync(path.join(__dirname, "LICENSE")) ? [{ from: "LICENSE", to: "LICENSE" }] : []),
  ],
  asar: false,
  npmRebuild: false,
  electronFuses: {
    runAsNode: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    grantFileProtocolExtraPrivileges: false,
  },
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
      NSCameraUsageDescription: `${CHILD_PROGRAMS} may ask to use the camera. Ruah itself never does.`,
      NSMicrophoneUsageDescription: `${CHILD_PROGRAMS} may ask to use the microphone. Ruah itself never does.`,
      NSAudioCaptureUsageDescription: `${CHILD_PROGRAMS} may ask to capture audio. Ruah itself never does.`,
      NSBluetoothAlwaysUsageDescription: `${CHILD_PROGRAMS} may ask to use Bluetooth. Ruah itself never does.`,
      NSBluetoothPeripheralUsageDescription: `${CHILD_PROGRAMS} may ask to use Bluetooth. Ruah itself never does.`,
    },
  },
  dmg: {
    title: `${flavor.productName} \${version}`,
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
