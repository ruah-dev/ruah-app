// src/projects/templates/basic.ts — "Empty" and "Static site".
import { dedent, escapeHtml, gitignore, jsString, type ProjectTemplate } from "./types.js";

export const emptyTemplate: ProjectTemplate = {
  id: "empty",
  name: "Empty",
  description: "A folder with a README and an empty map you draw yourself.",
  setupPrompt:
    "Set up the project: ask me what we are building, then propose a folder structure and the first elements for the map. Don't create files until I agree.",
  scan: false,
  files: ({ name }) => ({
    "README.md": dedent(`
      # ${name}

      Created with [Ruah](https://github.com/ruah-dev). Draw the architecture on the map
      (\`architecture.json\`), or ask the agent to set things up.
    `),
    ".gitignore": gitignore(),
  }),
};

export const staticSiteTemplate: ProjectTemplate = {
  id: "static-site",
  name: "Static site",
  description: "Plain HTML, CSS and JavaScript — no build step. Ruah's preview serves it as is.",
  // A real command (opens the page in the default browser); the hint card offers the Preview too.
  run: "open index.html",
  setupPrompt:
    "Set up the project: look at index.html, css/styles.css and js/main.js, then ask me what the site is for and propose the pages and sections to add.",
  scan: true,
  files: ({ name: raw, year }) => {
    const name = escapeHtml(raw);
    return {
    "index.html": dedent(`
      <!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>${name}</title>
          <link rel="icon" href="favicon.svg" type="image/svg+xml" />
          <link rel="stylesheet" href="css/styles.css" />
        </head>
        <body>
          <header class="site-header">
            <a class="brand" href="/">${name}</a>
            <nav>
              <a href="#about">About</a>
              <a href="#contact">Contact</a>
            </nav>
          </header>
          <main>
            <section class="hero">
              <h1>${name}</h1>
              <p>A static site — edit <code>index.html</code> and reload.</p>
              <button type="button" id="greet">Say hello</button>
              <p id="greeting" aria-live="polite"></p>
            </section>
            <section id="about">
              <h2>About</h2>
              <p>Tell visitors what this is about.</p>
            </section>
            <section id="contact">
              <h2>Contact</h2>
              <p>How to reach you.</p>
            </section>
          </main>
          <footer>© ${year} ${name}</footer>
          <script src="js/main.js" defer></script>
        </body>
      </html>
    `),
    "css/styles.css": dedent(`
      :root {
        color-scheme: light dark;
        --bg: #faf9f7;
        --fg: #1f1e1c;
        --muted: #6b675f;
        --accent: #137164;
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      @media (prefers-color-scheme: dark) {
        :root { --bg: #20201e; --fg: #f0eee9; --muted: #b8b3a8; --accent: #00d2b9; }
      }
      * { box-sizing: border-box; }
      body { margin: 0; background: var(--bg); color: var(--fg); line-height: 1.6; }
      .site-header, main, footer { max-width: 60rem; margin: 0 auto; padding: 1rem 1.5rem; }
      .site-header { display: flex; align-items: center; justify-content: space-between; }
      .site-header nav { display: flex; gap: 1rem; }
      a { color: var(--accent); }
      .brand { font-weight: 700; text-decoration: none; color: var(--fg); }
      .hero { padding: 4rem 0 2rem; }
      .hero h1 { font-size: clamp(2rem, 5vw, 3.25rem); margin: 0 0 0.5rem; }
      button { font: inherit; padding: 0.5rem 1rem; border-radius: 0.5rem; border: 1px solid var(--accent); background: transparent; color: var(--accent); cursor: pointer; }
      footer { color: var(--muted); font-size: 0.875rem; }
    `),
    "js/main.js": dedent(`
      // Small enhancements only: the page works without JavaScript.
      const button = document.getElementById("greet");
      const out = document.getElementById("greeting");
      button?.addEventListener("click", () => {
        if (out) out.textContent = ${jsString(`Hello from ${raw}!`)};
      });
    `),
    "favicon.svg": dedent(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#137164"/><text x="16" y="21" font-family="system-ui, sans-serif" font-size="16" font-weight="700" fill="#fff" text-anchor="middle">${(raw.match(/[A-Za-z0-9]/)?.[0] ?? "S").toUpperCase()}</text></svg>
    `),
    "README.md": dedent(`
      # ${raw}

      A static site: HTML, CSS and JavaScript, no build step.

      - \`index.html\` — the page
      - \`css/styles.css\` — styles (light and dark)
      - \`js/main.js\` — small enhancements

      Open \`index.html\` in a browser, or use Ruah's **Preview** (it serves the folder with live reload).
    `),
    ".gitignore": gitignore(),
  };
  },
};
