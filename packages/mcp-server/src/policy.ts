import type { AppConfig } from "./config.js";

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
  constructor(private cfg: AppConfig) {}

  evaluate(opts: { url: string; actionClass?: string }): PolicyDecision {
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
