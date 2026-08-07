import { describe, expect, it, vi } from "vitest";
import { createCachedAsync } from "../src/cached-async.js";

describe("createCachedAsync", () => {
  it("caches a resolved value across calls without re-invoking the factory", async () => {
    const factory = vi.fn().mockResolvedValue("value");
    const cache = createCachedAsync(factory);

    await expect(cache.get()).resolves.toBe("value");
    await expect(cache.get()).resolves.toBe("value");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("does not permanently cache a rejection: a later get() retries the factory", async () => {
    const factory = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient IdP outage"))
      .mockResolvedValueOnce("recovered");
    const cache = createCachedAsync(factory);

    await expect(cache.get()).rejects.toThrow("transient IdP outage");
    await expect(cache.get()).resolves.toBe("recovered");
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("does not replay a stale rejection to concurrent callers after a reset", async () => {
    const factory = vi
      .fn()
      .mockRejectedValueOnce(new Error("first failure"))
      .mockResolvedValueOnce("ok");
    const cache = createCachedAsync(factory);

    await expect(cache.get()).rejects.toThrow("first failure");
    // A second, unrelated failed get() shouldn't get stuck either.
    await expect(cache.get()).resolves.toBe("ok");
  });

  it("reset() forces the next get() to re-invoke the factory even after a success", async () => {
    const factory = vi.fn().mockResolvedValueOnce("first").mockResolvedValueOnce("second");
    const cache = createCachedAsync(factory);

    await expect(cache.get()).resolves.toBe("first");
    cache.reset();
    await expect(cache.get()).resolves.toBe("second");
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
