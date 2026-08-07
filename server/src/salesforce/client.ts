import { OAuthFlowError } from '../core/errors.js';
import type { OrgType } from '../core/types.js';

/**
 * Minimal REST client used during the connect flow: org identification only.
 * The full Metadata/Tooling engine arrives in P0.2 and builds on the same
 * token plumbing.
 */

export interface OrgInfo {
  orgId: string;
  orgName: string | null;
  isSandbox: boolean;
  organizationType: string | null;
  trialExpirationDate: string | null;
}

export interface IdentityInfo {
  username: string | null;
  userId: string | null;
  displayName: string | null;
}

export async function fetchOrgInfo(
  instanceUrl: string,
  accessToken: string,
  apiVersion: string,
): Promise<OrgInfo> {
  const soql =
    'SELECT Id, Name, IsSandbox, OrganizationType, TrialExpirationDate FROM Organization LIMIT 1';
  const url = new URL(`/services/data/${apiVersion}/query`, instanceUrl);
  url.searchParams.set('q', soql);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    throw new OAuthFlowError(
      `Could not read Organization from ${instanceUrl} (${res.status}). The OAuth login ` +
        `succeeded but the org query failed — check that the connected app has the "api" scope.`,
    );
  }
  const data = (await res.json()) as {
    records?: Array<{
      Id: string;
      Name: string | null;
      IsSandbox: boolean;
      OrganizationType: string | null;
      TrialExpirationDate: string | null;
    }>;
  };
  const rec = data.records?.[0];
  if (!rec) throw new OAuthFlowError('Organization query returned no rows.');
  return {
    orgId: rec.Id,
    orgName: rec.Name,
    isSandbox: rec.IsSandbox === true,
    organizationType: rec.OrganizationType,
    trialExpirationDate: rec.TrialExpirationDate,
  };
}

export async function fetchIdentity(idUrl: string, accessToken: string): Promise<IdentityInfo> {
  try {
    const res = await fetch(idUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return { username: null, userId: null, displayName: null };
    const data = (await res.json()) as {
      username?: string;
      user_id?: string;
      display_name?: string;
    };
    return {
      username: data.username ?? null,
      userId: data.user_id ?? null,
      displayName: data.display_name ?? null,
    };
  } catch {
    // Identity is enrichment, not a gate — the org query is the authoritative check.
    return { username: null, userId: null, displayName: null };
  }
}

export function classifyOrgType(info: OrgInfo): OrgType {
  if (info.isSandbox) return 'sandbox';
  if (info.trialExpirationDate) return 'trial';
  if (info.organizationType === 'Developer Edition') return 'developer';
  if (info.organizationType) return 'production';
  return 'unknown';
}
