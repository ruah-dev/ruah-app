// Live preview (CONTRACTS §18) — mount <PreviewPane/> in any slot; <PreviewPage/> is the /preview route.
// ./register's registerPreview() (called once at startup, src/router.tsx) puts the pane in the shell's preview slot.
export { PreviewPane, type PreviewPaneProps } from "./PreviewPane";
export { PreviewPage } from "./PreviewPage";
export { PreviewFrame, openInBrowser } from "./PreviewFrame";
export { StatusDot } from "./StatusDot";
