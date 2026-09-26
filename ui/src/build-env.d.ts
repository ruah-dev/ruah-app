// Build-time values stamped by ui/vite.config.ts (see lib/build-reload.ts).
interface ImportMetaEnv {
  /** Unique per `vite build`; the daemon reports the served one as `viewerBuild` (/api/health). */
  readonly VITE_RUAH_BUILD_ID?: string;
}
