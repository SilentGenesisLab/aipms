import { describe, expect, it } from "vitest";
import { API_PERMISSION_GROUPS, API_TOKEN_PERMISSIONS, DEFAULT_API_PERMISSIONS, HIGH_RISK_API_PERMISSIONS, hasApiPermission } from "./api-token-permissions";

describe("API token permissions", () => {
  it("keeps the catalog unique and defaults valid", () => {
    expect(new Set(API_TOKEN_PERMISSIONS).size).toBe(API_TOKEN_PERMISSIONS.length);
    expect(DEFAULT_API_PERMISSIONS.every((permission) => API_TOKEN_PERMISSIONS.includes(permission))).toBe(true);
  });
  it("does not imply write access from read access", () => {
    expect(hasApiPermission(["task:read"], "task:read")).toBe(true);
    expect(hasApiPermission(["task:read"], "task:report")).toBe(false);
    expect(hasApiPermission(["task:read"], "task:force_close")).toBe(false);
    expect(hasApiPermission(["document:read"], "document:write")).toBe(false);
  });
  it("offers force close without enabling it by default", () => {
    expect(API_TOKEN_PERMISSIONS).toContain("task:force_close");
    expect(DEFAULT_API_PERMISSIONS).not.toContain("task:force_close");
    expect(HIGH_RISK_API_PERMISSIONS).toContain("task:force_close");
    // Every permission must be reachable from the picker, which renders groups.
    const grouped = new Set(API_PERMISSION_GROUPS.flatMap((group) => [...group.permissions]));
    expect([...grouped].sort()).toEqual([...API_TOKEN_PERMISSIONS].sort());
  });
});
