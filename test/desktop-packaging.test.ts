// The macOS packaging config (electron-builder.config.cjs), its signing rules,
// the afterPack fix-ups and the bundled `ruah-app` shim.
import { afterEach, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);

interface BuilderConfig {
  appId: string;
  productName: string;
  artifactName: string;
  asar: boolean;
  npmRebuild: boolean;
  files: string[];
  extraResources: { from: string; to: string }[];
  afterPack: string;
  afterSign: string;
  extraMetadata?: Record<string, unknown>;
  electronFuses: Record<string, boolean>;
  mac: {
    target: { target: string; arch: string[] }[];
    icon: string;
    identity?: string | null;
    hardenedRuntime: boolean;
    notarize: boolean;
    signIgnore: string[];
    extendInfo: { CFBundleDocumentTypes: { LSItemContentTypes: string[]; LSHandlerRank: string }[] } & Record<string, unknown>;
  };
  dmg: { contents: { type: string; path?: string }[]; background: string };
}
interface Signing {
  identity: string | undefined;
  hardenedRuntime: boolean;
  notarize: boolean;
  developerId: boolean;
}

interface Flavor {
  flavor: string;
  appId: string;
  productName: string;
  artifactName: string;
  extraMetadata?: Record<string, unknown>;
}

const config = require("../electron-builder.config.cjs") as BuilderConfig;
const { macSigning } = require("../scripts/macos/signing.cjs") as { macSigning: (env: Record<string, string>) => Signing };
const { macFlavor } = require("../scripts/macos/flavor.cjs") as { macFlavor: (env: Record<string, string>) => Flavor };
const afterPack = require("../scripts/macos/after-pack.cjs") as { default: (context: unknown) => Promise<void> };
const afterSign = require("../scripts/macos/after-sign.cjs") as { checkFuses: (binary: string, env: NodeJS.ProcessEnv, cwd: string) => Promise<string> };

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ruah-dist-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("electron-builder config", () => {
  test("Ruah.app, dev.ruah.app, Ruah-<version>-arm64.dmg from icon.icns", () => {
    expect(config.appId).toBe("dev.ruah.app");
    expect(config.productName).toBe("Ruah");
    expect(config.artifactName).toBe("Ruah-${version}-${arch}.${ext}");
    expect(config.mac.target).toEqual([{ target: "dmg", arch: ["arm64"] }]);
    expect(config.mac.icon).toBe("electron/assets/icon.icns");
  });

  test("ships the daemon, the viewer and the shell; asar off, no native rebuild", () => {
    for (const pattern of ["package.json", "electron/**/*", "dist/**/*", "viewer/**/*"]) expect(config.files).toContain(pattern);
    expect(config.asar).toBe(false);
    expect(config.npmRebuild).toBe(false);
    expect(config.extraResources).toEqual(
      expect.arrayContaining([expect.objectContaining({ from: "electron/bin", to: "bin" }), { from: "THIRD_PARTY_NOTICES.md", to: "THIRD_PARTY_NOTICES.md" }]),
    );
    expect(config.afterPack).toBe("./scripts/macos/after-pack.cjs");
    expect(config.afterSign).toBe("./scripts/macos/after-sign.cjs");
  });

  test("fuses: the daemon's RunAsNode stays; NODE_OPTIONS, --inspect and file:// privileges are off", () => {
    expect(config.electronFuses).toEqual({
      runAsNode: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      grantFileProtocolExtraPrivileges: false,
    });
  });

  test("privacy strings are Ruah's own (Electron's generic \"This app needs access…\" never ships)", () => {
    const info = config.mac.extendInfo;
    for (const key of ["NSCameraUsageDescription", "NSMicrophoneUsageDescription", "NSAudioCaptureUsageDescription", "NSBluetoothAlwaysUsageDescription", "NSBluetoothPeripheralUsageDescription"]) {
      expect(info[key]).toMatch(/terminal or through its coding agents .* Ruah itself never does\.$/);
    }
    for (const key of ["NSDocumentsFolderUsageDescription", "NSDesktopFolderUsageDescription", "NSDownloadsFolderUsageDescription"]) {
      expect(info[key]).toMatch(/^Ruah /);
    }
  });

  test("Claude's native CLI keeps Anthropic's signature; nothing else is skipped", () => {
    const ignored = (file: string): boolean => config.mac.signIgnore.some((re) => new RegExp(re).test(file));
    expect(ignored("/r/Ruah.app/Contents/Resources/app/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude")).toBe(true);
    expect(ignored("/r/Ruah.app/Contents/Resources/app/node_modules/node-pty/prebuilds/darwin-arm64/pty.node")).toBe(false);
    expect(ignored("/r/Ruah.app/Contents/MacOS/Ruah")).toBe(false);
  });

  test("folders open with Ruah (never as their default app) and the dmg links /Applications", () => {
    const [folder] = config.mac.extendInfo.CFBundleDocumentTypes;
    expect(folder).toMatchObject({ LSItemContentTypes: ["public.folder"], LSHandlerRank: "Alternate" });
    expect(config.dmg.contents).toEqual(expect.arrayContaining([expect.objectContaining({ type: "link", path: "/Applications" })]));
    expect(statSync(resolve(config.dmg.background)).size).toBeGreaterThan(1000);
  });
});

describe("signing", () => {
  test("ad-hoc by default: no hardened runtime, no notarization, never a keychain guess", () => {
    expect(macSigning({})).toEqual({ identity: "-", hardenedRuntime: false, notarize: false, developerId: false });
    expect(macSigning({ RUAH_MAC_IDENTITY: "-" })).toMatchObject({ identity: "-", developerId: false });
    expect(macSigning({ APPLE_ID: "a", APPLE_APP_SPECIFIC_PASSWORD: "b", APPLE_TEAM_ID: "c" }).notarize).toBe(false);
  });

  test("a Developer ID turns on the hardened runtime; notarization needs Apple credentials too", () => {
    const named = macSigning({ RUAH_MAC_IDENTITY: "Jane Doe (TEAM123456)" });
    expect(named).toEqual({ identity: "Jane Doe (TEAM123456)", hardenedRuntime: true, notarize: false, developerId: true });
    expect(macSigning({ RUAH_MAC_IDENTITY: "Jane Doe (TEAM123456)", APPLE_API_KEY: "k.p8", APPLE_API_KEY_ID: "id", APPLE_API_ISSUER: "iss" }).notarize).toBe(true);
    expect(macSigning({ RUAH_MAC_IDENTITY: "Jane Doe (TEAM123456)", APPLE_KEYCHAIN_PROFILE: "ruah" }).notarize).toBe(true);
    expect(macSigning({ RUAH_MAC_IDENTITY: "Jane Doe (TEAM123456)", APPLE_ID: "a" }).notarize).toBe(false);
  });

  test("CSC_LINK / CSC_NAME leave the identity to electron-builder", () => {
    expect(macSigning({ CSC_LINK: "/secure/cert.p12" })).toMatchObject({ identity: undefined, hardenedRuntime: true, developerId: true });
    expect(macSigning({ CSC_NAME: "Jane Doe (TEAM123456)" })).toMatchObject({ identity: undefined, developerId: true });
  });
});

describe("flavors (RUAH_APP_FLAVOR)", () => {
  test("default: Ruah, dev.ruah.app, only the build stamp", () => {
    expect(macFlavor({})).toMatchObject({ flavor: "", appId: "dev.ruah.app", productName: "Ruah", artifactName: "Ruah-${version}-${arch}.${ext}" });
    expect(macFlavor({}).extraMetadata).toBeUndefined();
    // Only the build stamp (scripts/macos/build-stamp.cjs: which commit, for the app's updates).
    expect(Object.keys(config.extraMetadata ?? {})).toEqual(["ruahBuild"]);
  });

  test("a flavor is a side-by-side app: its own bundle id (macOS routes folders by it), name and package metadata", () => {
    expect(macFlavor({ RUAH_APP_FLAVOR: "test" })).toEqual({
      flavor: "test",
      appId: "dev.ruah.app.test",
      productName: "Ruah Test",
      artifactName: "Ruah-test-${version}-${arch}.${ext}",
      extraMetadata: { ruahFlavor: "test" },
    });
    expect(() => macFlavor({ RUAH_APP_FLAVOR: "Te st" })).toThrow(/RUAH_APP_FLAVOR/);
    expect(() => macFlavor({ RUAH_APP_FLAVOR: "../x" })).toThrow(/RUAH_APP_FLAVOR/);
  });
});

describe("afterSign fuse check", () => {
  test("it rejects a binary with Electron's default fuses (NODE_OPTIONS honoured)", async () => {
    const electron = require("electron") as string;
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
    delete env.NODE_OPTIONS;
    await expect(afterSign.checkFuses(electron, env, tempDir())).rejects.toThrow(/fuse EnableNodeOptionsEnvironmentVariable is on, expected off/);
  });
});

describe("afterPack and the bundled CLI", () => {
  function fakeBundle(dir: string): { bundle: string; context: unknown } {
    const outDir = join(dir, "mac-arm64");
    const bundle = join(outDir, "Ruah.app");
    const resources = join(bundle, "Contents", "Resources");
    mkdirSync(join(resources, "app", "node_modules", "node-pty", "prebuilds", "darwin-arm64"), { recursive: true });
    mkdirSync(join(resources, "bin"), { recursive: true });
    writeFileSync(join(resources, "app", "node_modules", "node-pty", "prebuilds", "darwin-arm64", "spawn-helper"), "bin");
    copyFileSync(resolve("electron/bin/ruah-app"), join(resources, "bin", "ruah-app"));
    chmodSync(join(resources, "bin", "ruah-app"), 0o644);
    copyFileSync(resolve("THIRD_PARTY_NOTICES.md"), join(resources, "THIRD_PARTY_NOTICES.md"));
    return { bundle, context: { electronPlatformName: "darwin", appOutDir: outDir, packager: { appInfo: { productFilename: "Ruah" } } } };
  }

  test("afterPack makes node-pty's spawn-helper and ruah-app executable", async () => {
    const { bundle, context } = fakeBundle(tempDir());
    await afterPack.default(context);
    const helper = join(bundle, "Contents", "Resources", "app", "node_modules", "node-pty", "prebuilds", "darwin-arm64", "spawn-helper");
    expect(statSync(helper).mode & 0o111).toBe(0o111);
    expect(statSync(join(bundle, "Contents", "Resources", "bin", "ruah-app")).mode & 0o111).toBe(0o111);
  });

  test("afterPack fails the build when spawn-helper is missing", async () => {
    const dir = tempDir();
    const { bundle, context } = fakeBundle(dir);
    rmSync(join(bundle, "Contents", "Resources", "app", "node_modules", "node-pty"), { recursive: true });
    await expect(afterPack.default(context)).rejects.toThrow(/spawn-helper/);
  });

  test("afterPack fails the build when the third-party notices are missing or incomplete", async () => {
    const { bundle, context } = fakeBundle(tempDir());
    const notices = join(bundle, "Contents", "Resources", "THIRD_PARTY_NOTICES.md");
    writeFileSync(notices, "# Third-party notices\n\nPermission is hereby granted\n");
    await expect(afterPack.default(context)).rejects.toThrow(/THIRD_PARTY_NOTICES\.md lacks: .*T3 Tools/);
    rmSync(notices);
    await expect(afterPack.default(context)).rejects.toThrow(/THIRD_PARTY_NOTICES\.md is missing/);
  });

  test("the notices name every adapted file that exists and ship Ruah's LICENSE once there is one", () => {
    const text = readFileSync(resolve("THIRD_PARTY_NOTICES.md"), "utf8");
    const listed = [...text.matchAll(/^\| `((?:src|ui\/src)\/[^`]+)` \|/gm)].map((m) => m[1]!);
    expect(listed.length).toBeGreaterThan(20);
    for (const file of listed) expect(existsSync(resolve(file)), file).toBe(true);
    const license = config.extraResources.some((r) => r.from === "LICENSE");
    expect(license).toBe(existsSync(resolve("LICENSE")));
  });

  test("Resources/bin/ruah-app finds a flavored bundle's binary through Info.plist", () => {
    const dir = tempDir();
    const { bundle } = fakeBundle(dir);
    mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
    const binary = join(bundle, "Contents", "MacOS", "Ruah Test");
    writeFileSync(binary, '#!/bin/sh\necho "flavored $1"\n');
    chmodSync(binary, 0o755);
    writeFileSync(
      join(bundle, "Contents", "Info.plist"),
      '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Ruah Test</string></dict></plist>\n',
    );
    const shim = join(bundle, "Contents", "Resources", "bin", "ruah-app");
    chmodSync(shim, 0o755);
    const out = spawnSync(shim, [], { encoding: "utf8" });
    if (process.platform === "darwin") expect(out.stdout.trim()).toBe(`flavored ${join(bundle, "Contents", "Resources", "app", "dist", "cli.js")}`);
  });

  test("Resources/bin/ruah-app runs dist/cli.js on the app binary as Node, also through a symlink", () => {
    const dir = tempDir();
    const { bundle } = fakeBundle(dir);
    const binary = join(bundle, "Contents", "MacOS", "Ruah");
    mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
    writeFileSync(binary, '#!/bin/sh\necho "node=$ELECTRON_RUN_AS_NODE"\nfor a in "$@"; do echo "arg=$a"; done\n');
    chmodSync(binary, 0o755);
    const shim = join(bundle, "Contents", "Resources", "bin", "ruah-app");
    chmodSync(shim, 0o755);
    mkdirSync(join(dir, "usr-local-bin"));
    const link = join(dir, "usr-local-bin", "ruah-app");
    symlinkSync(shim, link);
    for (const entry of [shim, link]) {
      const out = spawnSync(entry, ["doctor", "--json"], { encoding: "utf8" });
      expect(out.status).toBe(0);
      expect(out.stdout.trim().split("\n")).toEqual([
        "node=1",
        `arg=${join(bundle, "Contents", "Resources", "app", "dist", "cli.js")}`,
        "arg=doctor",
        "arg=--json",
      ]);
    }
  });
});
