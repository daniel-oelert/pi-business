/**
 * Tests for src/types.ts — Event constants and interfaces.
 *
 * These are compile-time/structural tests that verify the
 * constants are defined correctly and consistent.
 */

import { describe, it, expect } from "vitest";
import {
  BASH_PERMISSION_REQUESTED,
  BASH_PERMISSION_RESPONSE,
} from "../types";
import type {
  BashPermissionRequestedEvent,
  BashPermissionResponseEvent,
} from "../types";

describe("Event constants", () => {
  it("BASH_PERMISSION_REQUESTED uses correct pibusiness prefix", () => {
    expect(BASH_PERMISSION_REQUESTED).toBe("pibusiness:bash_permission_requested");
    expect(BASH_PERMISSION_REQUESTED.startsWith("pibusiness:")).toBe(true);
  });

  it("BASH_PERMISSION_RESPONSE uses correct pibusiness prefix", () => {
    expect(BASH_PERMISSION_RESPONSE).toBe("pibusiness:bash_permission_response");
    expect(BASH_PERMISSION_RESPONSE.startsWith("pibusiness:")).toBe(true);
  });

  it("request and response are different constants", () => {
    expect(BASH_PERMISSION_REQUESTED).not.toBe(BASH_PERMISSION_RESPONSE);
  });

  it("both constants are non-empty strings", () => {
    expect(BASH_PERMISSION_REQUESTED.length).toBeGreaterThan(0);
    expect(BASH_PERMISSION_RESPONSE.length).toBeGreaterThan(0);
  });
});

describe("BashPermissionRequestedEvent interface shape", () => {
  it("requires requestId and command", () => {
    const event: BashPermissionRequestedEvent = {
      requestId: "req-123",
      command: "rm -rf /tmp/test",
    };
    expect(typeof event.requestId).toBe("string");
    expect(typeof event.command).toBe("string");
  });

  it("can hold long commands", () => {
    const longCommand = "echo " + "x".repeat(10000);
    const event: BashPermissionRequestedEvent = {
      requestId: "req-long",
      command: longCommand,
    };
    expect(event.command.length).toBe(10000 + 5); // "echo " + 10000 x's
  });
});

describe("BashPermissionResponseEvent interface shape", () => {
  it("requires requestId and allowed", () => {
    const event: BashPermissionResponseEvent = {
      requestId: "req-456",
      allowed: true,
    };
    expect(typeof event.requestId).toBe("string");
    expect(event.allowed).toBe(true);
  });

  it("reason is optional and can be a string", () => {
    const denied: BashPermissionResponseEvent = {
      requestId: "req-789",
      allowed: false,
      reason: "Blocked by user",
    };
    expect(denied.reason).toBe("Blocked by user");
  });

  it("reason can be undefined", () => {
    const allowed: BashPermissionResponseEvent = {
      requestId: "req-allowed",
      allowed: true,
    };
    expect(allowed.reason).toBeUndefined();
  });
});

describe("Event round-trip consistency", () => {
  it("requestId matches between request and response", () => {
    const requestId = "bash-permission-1234567890-abc123def";

    const request: BashPermissionRequestedEvent = {
      requestId,
      command: "sudo systemctl restart nginx",
    };

    const response: BashPermissionResponseEvent = {
      requestId,
      allowed: true,
    };

    // The whole point of requestId is matching
    expect(response.requestId).toBe(request.requestId);
  });

  it("response can deny with a reason", () => {
    const response: BashPermissionResponseEvent = {
      requestId: "req-deny",
      allowed: false,
      reason: "UI Error: dialog closed unexpectedly",
    };
    expect(response.allowed).toBe(false);
    expect(response.reason).toContain("UI Error");
  });
});
