import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Package specifier used to locate the UI build regardless of layout:
 * `import.meta.resolve` follows Node's normal module resolution (workspace
 * symlink in a pnpm dev checkout, or a regular `node_modules` entry in a
 * `pnpm deploy`-flattened production image), so this doesn't need to guess
 * a relative `../..` path that differs between those two layouts — see the
 * git history of this file for the two subtly-wrong path traversals that
 * `path.resolve(__dirname, "../../transport-web/ui/dist")` produced before
 * this fix (wrong number of `..` segments in both dev and prod).
 */
const TRANSPORT_WEB_PACKAGE_JSON = "@paperclip-chat-gateway/transport-web/package.json";

export class UiDistNotFoundError extends Error {
  constructor(uiDistPath: string, options?: { cause?: unknown }) {
    super(
      `UI static assets not found at "${uiDistPath}" (missing index.html). Did you run ` +
        '"pnpm --filter @paperclip-chat-gateway/transport-web run build:ui"? If your deployment ' +
        "copies the built UI to a nonstandard location, set UI_DIST_PATH to override this.",
      options,
    );
    this.name = "UiDistNotFoundError";
  }
}

export interface ResolveUiDistPathOptions {
  /** Explicit override, e.g. from the UI_DIST_PATH env var. Takes precedence over package resolution. */
  override?: string;
  /** Injectable for tests; defaults to Node's `import.meta.resolve`. */
  resolvePackageJson?: (specifier: string) => string;
}

/**
 * Resolves the absolute path to the built UI's static assets by locating
 * `@paperclip-chat-gateway/transport-web`'s own `package.json` via normal
 * Node module resolution, then appending `ui/dist` — the one thing that is
 * *not* environment-dependent, since transport-web's own directory layout
 * (`<package root>/ui/dist`) doesn't change between dev and the Docker
 * image (only the package's location on disk does, and module resolution
 * already knows how to find that).
 */
export function resolveUiDistPath(options: ResolveUiDistPathOptions = {}): string {
  if (options.override) {
    return path.resolve(options.override);
  }
  const resolvePackageJson = options.resolvePackageJson ?? ((specifier: string) => import.meta.resolve(specifier));
  const packageJsonUrl = resolvePackageJson(TRANSPORT_WEB_PACKAGE_JSON);
  const packageDir = path.dirname(fileURLToPath(packageJsonUrl));
  return path.join(packageDir, "ui", "dist");
}

/** Fails fast with a clear message if the resolved UI dist directory doesn't actually exist. */
export async function assertUiDistExists(uiDistPath: string): Promise<void> {
  try {
    await access(path.join(uiDistPath, "index.html"));
  } catch (error) {
    throw new UiDistNotFoundError(uiDistPath, { cause: error });
  }
}
