// scripts/macos/signing.cjs — how `pnpm dist` signs Ruah.app, from the environment
// (used by electron-builder.config.cjs; tested in test/desktop-packaging.test.ts).
//
// Default: ad-hoc ("-"): runs on this Mac; on others after "Open Anyway".
// Developer ID: RUAH_MAC_IDENTITY="Name (TEAMID)" (a keychain identity; the
// "Developer ID Application: " prefix is optional; electron-builder's CSC_NAME
// works too) or CSC_LINK (+ CSC_KEY_PASSWORD) with a .p12 — then the
// hardened runtime is on, and notarization runs when Apple credentials are set:
// APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER, or APPLE_ID +
// APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID, or APPLE_KEYCHAIN_PROFILE.

/** Signing from the environment: ad-hoc unless a Developer ID is configured. */
function macSigning(env = process.env) {
  const identity = typeof env.RUAH_MAC_IDENTITY === "string" ? env.RUAH_MAC_IDENTITY.trim() : "";
  const certificate =
    (typeof env.CSC_LINK === "string" && env.CSC_LINK.trim().length > 0) ||
    (typeof env.CSC_NAME === "string" && env.CSC_NAME.trim().length > 0);
  const developerId = (identity.length > 0 && identity !== "-") || certificate;
  const notarizeCreds =
    (Boolean(env.APPLE_API_KEY) && Boolean(env.APPLE_API_KEY_ID) && Boolean(env.APPLE_API_ISSUER)) ||
    (Boolean(env.APPLE_ID) && Boolean(env.APPLE_APP_SPECIFIC_PASSWORD) && Boolean(env.APPLE_TEAM_ID)) ||
    Boolean(env.APPLE_KEYCHAIN_PROFILE);
  return {
    // "-" = ad-hoc (runs on this Mac and, after "Open Anyway", on others). A name
    // or CSC_LINK / CSC_NAME (electron-builder reads them itself) signs for real;
    // with neither, never pick up whatever identity the keychain happens to hold.
    identity: identity.length > 0 ? identity : certificate ? undefined : "-",
    hardenedRuntime: developerId,
    notarize: developerId && notarizeCreds,
    developerId,
  };
}

module.exports = { macSigning };
