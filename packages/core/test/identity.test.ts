import { describe, expect, it } from "vitest";
import { ConfigIdentityResolver, DuplicateEmployeeEmailError } from "../src/identity.js";

describe("ConfigIdentityResolver", () => {
  it("resolves verified claims to the matching employee, case-insensitively on email", async () => {
    const resolver = new ConfigIdentityResolver([{ employeeId: "emp-alice", email: "Alice@Example.com", name: "Alice" }]);

    await expect(resolver.resolve({ subject: "sub-1", email: "alice@example.com" })).resolves.toEqual({
      employeeId: "emp-alice",
      email: "Alice@Example.com",
      name: "Alice",
    });
  });

  it("returns null for an unregistered email (no implicit provisioning)", async () => {
    const resolver = new ConfigIdentityResolver([{ employeeId: "emp-alice", email: "alice@example.com" }]);
    await expect(resolver.resolve({ subject: "sub-1", email: "mallory@example.com" })).resolves.toBeNull();
  });

  it("returns null when claims carry no email at all", async () => {
    const resolver = new ConfigIdentityResolver([{ employeeId: "emp-alice", email: "alice@example.com" }]);
    await expect(resolver.resolve({ subject: "sub-1" })).resolves.toBeNull();
  });

  it("fails closed at construction time on a duplicate (case-insensitive) email, instead of silently picking one", () => {
    expect(
      () =>
        new ConfigIdentityResolver([
          { employeeId: "emp-alice", email: "alice@example.com" },
          { employeeId: "emp-alice-2", email: "Alice@Example.com" },
        ]),
    ).toThrow(DuplicateEmployeeEmailError);
  });
});
