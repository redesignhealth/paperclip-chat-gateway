import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertUiDistExists, resolveUiDistPath, UiDistNotFoundError } from "../src/ui-dist.js";

describe("resolveUiDistPath", () => {
  it("returns the explicit override, resolved to an absolute path, without consulting module resolution", () => {
    const resolvePackageJson = () => {
      throw new Error("should not be called when an override is given");
    };
    const result = resolveUiDistPath({ override: "./some/relative/dir", resolvePackageJson });
    expect(path.isAbsolute(result)).toBe(true);
    expect(result.endsWith(path.join("some", "relative", "dir"))).toBe(true);
  });

  it("derives the path from the transport-web package's own location, not a relative __dirname traversal", () => {
    const fakePackageDir = "/fake/layout/node_modules/@paperclip-chat-gateway/transport-web";
    const resolvePackageJson = (specifier: string) => {
      expect(specifier).toBe("@paperclip-chat-gateway/transport-web/package.json");
      return pathToFileURL(path.join(fakePackageDir, "package.json")).toString();
    };

    const result = resolveUiDistPath({ resolvePackageJson });
    expect(result).toBe(path.join(fakePackageDir, "ui", "dist"));
  });

  // Exercising the *default* resolvePackageJson (real `import.meta.resolve`)
  // isn't testable under vitest's SSR module loader, which doesn't
  // implement `import.meta.resolve` (this is a vitest/vite-node limitation,
  // not something this code can work around) — the injected-resolver tests
  // above cover the actual path-joining logic, and this is exercised for
  // real every time the built gateway starts (see the Docker/manual
  // smoke-test notes in apps/gateway/Dockerfile).
});

describe("assertUiDistExists", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pcg-ui-dist-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("resolves when index.html is present", async () => {
    await writeFile(path.join(dir, "index.html"), "<html></html>");
    await expect(assertUiDistExists(dir)).resolves.toBeUndefined();
  });

  it("throws UiDistNotFoundError with a clear message when the directory is missing entirely", async () => {
    const missing = path.join(dir, "does-not-exist");
    await expect(assertUiDistExists(missing)).rejects.toThrow(UiDistNotFoundError);
  });

  it("throws UiDistNotFoundError when the directory exists but has no index.html (e.g. UI build never ran)", async () => {
    const emptyDir = path.join(dir, "empty");
    await mkdir(emptyDir);
    await expect(assertUiDistExists(emptyDir)).rejects.toThrow(UiDistNotFoundError);
  });
});
