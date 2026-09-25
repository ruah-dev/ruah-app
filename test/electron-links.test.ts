// electron/links.cjs: the app window stays on the daemon's viewer; web links
// (agent Markdown, cloud resource URLs, target="_blank") go to the default
// browser instead of loading an outside page that would get window.ruah.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { sameOrigin, webUrl } = require("../electron/links.cjs") as {
  sameOrigin: (url: string, base: string) => boolean;
  webUrl: (url: unknown) => string | null;
};

describe("electron link rules", () => {
  it("keeps only the viewer's origin in the window", () => {
    expect(sameOrigin("http://127.0.0.1:4177/map", "http://127.0.0.1:4177")).toBe(true);
    expect(sameOrigin("http://127.0.0.1:4178/", "http://127.0.0.1:4177")).toBe(false);
    expect(sameOrigin("https://evil.example/", "http://127.0.0.1:4177")).toBe(false);
    expect(sameOrigin("file:///Users/me/shot.png", "http://127.0.0.1:4177")).toBe(false);
    expect(sameOrigin("not a url", "http://127.0.0.1:4177")).toBe(false);
  });

  it("hands only web pages to the browser", () => {
    expect(webUrl("https://app.example.com/x")).toBe("https://app.example.com/x");
    expect(webUrl("file:///etc/passwd")).toBeNull();
    expect(webUrl("vscode://file/x")).toBeNull();
    expect(webUrl(42)).toBeNull();
  });

  it("main.cjs routes navigations and window.open through them", () => {
    const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
    expect(main).toContain("setWindowOpenHandler");
    expect(main).toMatch(/will-navigate[\s\S]{0,200}sameOrigin\(url, BASE\)/);
    expect(main).toContain('daemon.on("error"');
  });
});
