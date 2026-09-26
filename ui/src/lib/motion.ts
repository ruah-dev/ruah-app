// Reduced motion, in one place. styles.css stops CSS animations and transitions under
// `prefers-reduced-motion: reduce`, but script-driven motion ignores that rule: a
// `scrollIntoView({ behavior: "smooth" })` still glides, Web Animations still run. Script motion
// asks here first (ui/test/a11y-static.test.ts keeps it that way).

/** True when the user asked the system for less motion. False outside a browser. */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** The `behavior` for scrolling: smooth, unless the user asked for less motion. */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth";
}
