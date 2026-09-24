// Onboarding helpers for the "Connect a provider" list (CONTRACTS.md §10): which state a
// provider is in and which commands fix it.
import { describe, expect, test } from "vitest";
import type { IntegrationInfo } from "@/lib/contracts";
import { providerLabel, providerSetupState, setupCommands } from "@/lib/integrations";

const gcp = (extra: Partial<IntegrationInfo>): IntegrationInfo => ({
  id: "gcp",
  family: "cloud",
  name: "Google Cloud",
  status: "not_connected",
  installCommand: "brew install --cask gcloud-cli",
  loginCommand: "gcloud auth login",
  ...extra,
});

describe("provider setup", () => {
  test("states", () => {
    expect(providerSetupState(gcp({ status: "connected" }))).toBe("connected");
    expect(providerSetupState(gcp({ status: "cli_missing" }))).toBe("not_installed");
    expect(providerSetupState(gcp({ detail: "not logged in to gcloud" }))).toBe("not_logged_in");
    expect(providerSetupState(gcp({ detail: "disconnected in Ruah (gcloud login unchanged)" }))).toBe("disconnected");
    expect(providerSetupState(gcp({ status: "error" }))).toBe("error");
  });

  test("commands: install then log in; login only; a logged-in CLI's own fix; nothing when connected", () => {
    expect(setupCommands(gcp({ status: "cli_missing", setupHint: "brew install --cask gcloud-cli && gcloud auth login" }))).toEqual([
      { label: "Install", command: "brew install --cask gcloud-cli" },
      { label: "Log in", command: "gcloud auth login" },
    ]);
    expect(setupCommands(gcp({ setupHint: "gcloud auth login" }))).toEqual([{ label: "Log in", command: "gcloud auth login" }]);
    expect(setupCommands(gcp({ setupHint: "gcloud config set project PROJECT_ID" }))).toEqual([
      { label: "Set up", command: "gcloud config set project PROJECT_ID" },
    ]);
    expect(setupCommands(gcp({ status: "connected" }))).toEqual([]);
    expect(setupCommands(gcp({ detail: "disconnected in Ruah (gcloud login unchanged)" }))).toEqual([]);
  });

  test("providers without the §10 fields fall back to setupHint", () => {
    const aws: IntegrationInfo = { id: "aws", family: "cloud", name: "AWS", status: "cli_missing", setupHint: "brew install awscli && aws configure sso" };
    expect(setupCommands(aws)).toEqual([{ label: "Run", command: "brew install awscli && aws configure sso" }]);
  });

  test("labels", () => {
    expect(["gcp", "azure", "cloudflare", "railway", "fly"].map(providerLabel)).toEqual(["Google Cloud", "Azure", "Cloudflare", "Railway", "Fly.io"]);
  });
});
