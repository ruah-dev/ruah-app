// Pure URL rules for the Electron main process (main.cjs): which navigations
// stay in the app window and which URLs may go to the default browser.

/** Whether `url` is on the same origin as `base` (the daemon's viewer). */
function sameOrigin(url, base) {
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/** The URL when it is a web page (http / https), else null (file:, custom schemes, app handlers). */
function webUrl(url) {
  if (typeof url !== "string" || url.length > 8192) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
}

module.exports = { sameOrigin, webUrl };
