import { statSync } from "node:fs";
import { localConfigPath, readLocalOverride, type AppConfig } from "./config.js";

export interface PolicyDecision {
  allow: boolean;
  requiresEscalation: boolean;
  reason: string;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function domainMatch(host: string, domains: string[]): boolean {
  return domains.some((d) => host === d || host.endsWith("." + d));
}

/**
 * General-purpose policy for an open web agent.
 *
 * The browser is not restricted to an allowlist: navigation and ordinary
 * interaction (click, type, fill, submit, …) are permitted on any domain.
 * The only gate is action CLASS — a small set of genuinely consequential
 * things (payment, destructive delete, credential entry, file upload).
 * Those run without friction on `trustedDomains` and escalate elsewhere.
 *
 * Callers label an action by passing `actionClass`; nothing is inferred from
 * the verb alone, so a search-box submit is not treated as a payment.
 */
export class Policy {
  private mtime = 0;
  readonly localFile = localConfigPath();

  constructor(private cfg: AppConfig) {}

  /**
   * Pick up an edit to the person's own config without a restart: the file is
   * read when it changes, so an approved change to trustedDomains takes effect
   * on the very next action.
   */
  refresh(): void {
    try {
      const m = statSync(this.localFile).mtimeMs;
      if (m === this.mtime) return;
      this.mtime = m;
      const local = readLocalOverride(this.localFile);
      const trusted = (local?.policy as { trustedDomains?: string[] } | undefined)?.trustedDomains;
      if (trusted) this.cfg.policy.trustedDomains = trusted;
    } catch {
      // No override file is the normal case.
    }
  }

  evaluate(opts: { url: string; actionClass?: string }): PolicyDecision {
    this.refresh();
    const host = hostOf(opts.url);
    const trusted = domainMatch(host, this.cfg.policy.trustedDomains);
    const sensitive =
      !!opts.actionClass && this.cfg.policy.sensitiveActionClasses.includes(opts.actionClass);

    if (!sensitive) return { allow: true, requiresEscalation: false, reason: "ordinary action" };
    if (trusted)
      return { allow: true, requiresEscalation: false, reason: `trusted domain: ${host}` };
    return {
      allow: false,
      requiresEscalation: true,
      reason: `sensitive action '${opts.actionClass}' on untrusted ${host}`,
    };
  }
}

/** The blocked domain a URL falls under for browser_eval, or undefined. */
export function evalBlockedBy(url: string, blockedDomains: string[]): string | undefined {
  const host = hostOf(url);
  return host ? blockedDomains.find((d) => host === d || host.endsWith("." + d)) : undefined;
}
