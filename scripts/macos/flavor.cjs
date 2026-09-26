// scripts/macos/flavor.cjs — which app `pnpm dist` builds, from the environment
// (used by electron-builder.config.cjs; tested in test/desktop-packaging.test.ts).
//
// Default: Ruah.app, bundle id dev.ruah.app. RUAH_APP_FLAVOR=<name> (lower-case
// letters, digits, dashes; e.g. "test") builds a side-by-side copy — "Ruah Test.app",
// bundle id dev.ruah.app.test, its own profile and logs — for trying a build next to
// the installed app. A separate bundle id is what keeps them apart: macOS hands
// `open -a`, Finder "Open With" and Dock drops to whichever app with that id runs,
// whatever RUAH_HOME it was started with.
const { FLAVOR, appIdentity } = require("../../electron/app-shell.cjs");

function macFlavor(env = process.env) {
  const raw = typeof env.RUAH_APP_FLAVOR === "string" ? env.RUAH_APP_FLAVOR.trim() : "";
  if (raw.length === 0) {
    return { flavor: "", appId: "dev.ruah.app", productName: "Ruah", artifactName: "Ruah-${version}-${arch}.${ext}", extraMetadata: undefined };
  }
  if (!FLAVOR.test(raw)) throw new Error(`RUAH_APP_FLAVOR must be lower-case letters, digits and dashes, starting with a letter (got "${raw}")`);
  return {
    flavor: raw,
    appId: `dev.ruah.app.${raw}`,
    productName: appIdentity({ ruahFlavor: raw }).name,
    artifactName: `Ruah-${raw}-\${version}-\${arch}.\${ext}`,
    // electron/main.cjs reads it (desktop.appIdentity) for the app's name, profile and logs.
    extraMetadata: { ruahFlavor: raw },
  };
}

module.exports = { macFlavor };
