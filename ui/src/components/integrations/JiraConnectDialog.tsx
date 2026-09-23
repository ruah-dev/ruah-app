// Jira connect: site + email + API token. The token goes to the daemon once, which stores it in
// the macOS Keychain (service "ruah"); the field is cleared after every submit and the token is
// never shown again.
import { useState, type FormEvent } from "react";
import { ExternalLink, KeyRound, Loader2 } from "lucide-react";
import { connectIntegration } from "@/lib/integrations";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ProviderMark, primaryButton, quietButton } from "./common";

const TOKEN_PAGE = "https://id.atlassian.com/manage-profile/security/api-tokens";

export function normalizeSite(raw: string): string {
  return raw.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
}

export function JiraConnectDialog({
  open,
  onOpenChange,
  defaultSite = "",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultSite?: string;
}) {
  const [site, setSite] = useState(defaultSite);
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const siteValue = normalizeSite(site);
  const valid = /^[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?$/.test(siteValue) && /.+@.+\..+/.test(email.trim()) && token.length > 0;

  const close = (next: boolean) => {
    if (!next) {
      setToken("");
      setError(null);
    }
    onOpenChange(next);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    const secret = token;
    setToken(""); // never keep the token around, whatever the outcome
    const res = await connectIntegration("jira", { site: siteValue, email: email.trim(), token: secret });
    setBusy(false);
    if (res.ok && res.data.status === "connected") {
      close(false);
      return;
    }
    setError(
      res.ok
        ? (res.data.detail ?? "Jira did not accept these credentials.")
        : res.status === 401 || res.status === 403
          ? "Jira rejected the email or token."
          : res.message,
    );
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md gap-5 rounded-xl p-5">
        <DialogHeader className="flex-row items-center gap-3 space-y-0 text-left">
          <ProviderMark id="jira" />
          <div className="min-w-0">
            <DialogTitle className="text-[15px]">Connect Jira</DialogTitle>
            <DialogDescription className="text-[12.5px]">
              Link issues to architecture elements and create them from Ruah.
            </DialogDescription>
          </div>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4" autoComplete="off">
          <div className="space-y-1.5">
            <Label htmlFor="jira-site" className="text-[12.5px] font-normal text-muted-foreground">
              Site
            </Label>
            <Input
              id="jira-site"
              value={site}
              onChange={(e) => setSite(e.target.value)}
              placeholder="your-team.atlassian.net"
              spellCheck={false}
              className="h-8 text-[13px] md:text-[13px]"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="jira-email" className="text-[12.5px] font-normal text-muted-foreground">
              Email
            </Label>
            <Input
              id="jira-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              className="h-8 text-[13px] md:text-[13px]"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="jira-token" className="text-[12.5px] font-normal text-muted-foreground">
              API token
            </Label>
            <Input
              id="jira-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="new-password"
              spellCheck={false}
              placeholder="Paste a token"
              className="h-8 font-mono text-[13px] md:text-[13px]"
            />
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              Create one at{" "}
              <a
                href={TOKEN_PAGE}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 text-foreground/85 underline-offset-2 hover:underline"
              >
                id.atlassian.com → Security → API tokens
                <ExternalLink className="size-3" />
              </a>
              .
            </p>
          </div>

          <div className="flex items-start gap-2 rounded-lg bg-foreground/[0.04] px-3 py-2.5 text-[12px] leading-relaxed text-muted-foreground">
            <KeyRound className="mt-0.5 size-3.5 shrink-0" />
            <span>
              The token is stored in your macOS Keychain (service <span className="font-mono">ruah</span>), not in
              a file. Ruah never shows it again; disconnect removes it.
            </span>
          </div>

          {error ? <p className="text-[12.5px] text-bad">{error}</p> : null}

          <DialogFooter className="gap-2 sm:gap-1">
            <button type="button" className={quietButton} onClick={() => close(false)}>
              Cancel
            </button>
            <button type="submit" className={primaryButton} disabled={!valid || busy}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Connect
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
