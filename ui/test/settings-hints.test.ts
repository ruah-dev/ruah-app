// Regression: Settings → Integrations showed a fixed "Connected services: DigitalOcean, AWS, Jira,
// GitHub, ruah" whether or not any of them was installed or connected.
import { describe, expect, it } from "vitest";
import { connectedServicesHint } from "@/lib/settings-hints";

describe("connectedServicesHint", () => {
  it("names only what is connected", () => {
    expect(
      connectedServicesHint([
        { name: "DigitalOcean", status: "connected" },
        { name: "AWS", status: "cli_missing" },
        { name: "Jira", status: "not_connected" },
        { name: "GitHub", status: "connected" },
      ]),
    ).toBe("DigitalOcean, GitHub connected");
    expect(connectedServicesHint([{ name: "AWS", status: "cli_missing" }])).toMatch(/^Nothing connected yet/);
    expect(connectedServicesHint(null)).toBe("Cloud providers, Jira, GitHub and ruah");
    const many = ["A", "B", "C", "D", "E", "F"].map((name) => ({ name, status: "connected" as const }));
    expect(connectedServicesHint(many)).toBe("A, B, C, D and 2 more connected");
  });
});
