import { describe, expect, it } from "vitest";
import {
  describeTokenCaps,
  groupCapabilities,
  isReadCapability,
  presetCaps,
} from "./token-access";

const grantable = ["tasks:create", "tasks:read", "tasks:read-all", "repos:read", "usage:read-all"];

describe("token access", () => {
  it("treats read and read-all as read capabilities, nothing else", () => {
    expect(isReadCapability("tasks:read")).toBe(true);
    expect(isReadCapability("usage:read-all")).toBe(true);
    expect(isReadCapability("chat:write")).toBe(false);
    expect(isReadCapability("tasks:steer-all")).toBe(false);
  });

  it("expands presets against what the person may grant", () => {
    expect(presetCaps("all", grantable)).toEqual(grantable);
    expect(presetCaps("read", grantable)).toEqual([
      "tasks:read",
      "tasks:read-all",
      "repos:read",
      "usage:read-all",
    ]);
    expect(presetCaps("custom", grantable)).toEqual([]);
  });

  it("groups by resource in catalogue order", () => {
    expect(groupCapabilities(grantable)).toEqual([
      {
        resource: "tasks",
        label: "Tasks",
        caps: [
          { capability: "tasks:create", verb: "create" },
          { capability: "tasks:read", verb: "read" },
          { capability: "tasks:read-all", verb: "read-all" },
        ],
      },
      { resource: "repos", label: "Repos", caps: [{ capability: "repos:read", verb: "read" }] },
      { resource: "usage", label: "Usage", caps: [{ capability: "usage:read-all", verb: "read-all" }] },
    ]);
  });

  it("describes a minted token's caps", () => {
    expect(describeTokenCaps(["tasks:read", "repos:read"])).toBe("Read only, 2 capabilities");
    expect(describeTokenCaps(["tasks:create"])).toBe("1 capability");
  });
});
