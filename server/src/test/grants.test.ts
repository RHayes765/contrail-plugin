import { describe, expect, it } from 'vitest';
import {
  GRANTS,
  TOOL_GRANT_MAP,
  emptyGrantSet,
  grantDependencyViolations,
  grantedList,
  normalizeGrants,
  notGrantedList,
} from '../core/grants.js';

describe('grants', () => {
  it('normalizes form-style input ("on") and JSON booleans, ignoring junk', () => {
    const g = normalizeGrants({
      metadata_read: 'on',
      data_read: true,
      data_write: 'false',
      bogus_grant: true,
      __proto__: { diagnostics_read: true },
    });
    expect(g).toEqual({
      metadata_read: true,
      metadata_write: false,
      diagnostics_read: false,
      data_read: true,
      data_write: false,
    });
  });

  it('normalizes garbage input to an empty grant set', () => {
    expect(normalizeGrants(null)).toEqual(emptyGrantSet());
    expect(normalizeGrants('metadata_read')).toEqual(emptyGrantSet());
    expect(normalizeGrants(42)).toEqual(emptyGrantSet());
  });

  it('flags write-without-read dependency violations', () => {
    const g = emptyGrantSet();
    g.metadata_write = true;
    g.data_write = true;
    const violations = grantDependencyViolations(g);
    expect(violations).toContain('metadata_write requires metadata_read');
    expect(violations).toContain('data_write requires data_read');
  });

  it('accepts writes when the matching read is present', () => {
    const g = emptyGrantSet();
    g.metadata_read = true;
    g.metadata_write = true;
    expect(grantDependencyViolations(g)).toEqual([]);
  });

  it('splits granted vs not-granted covering all five grants', () => {
    const g = emptyGrantSet();
    g.diagnostics_read = true;
    expect(grantedList(g)).toEqual(['diagnostics_read']);
    expect([...grantedList(g), ...notGrantedList(g)].sort()).toEqual([...GRANTS].sort());
  });

  it('classifies every P0.1 tool in the tool→grant map', () => {
    for (const tool of [
      'connect_org',
      'disconnect_org',
      'manage_connection',
      'list_connections',
      'get_permissions',
      'get_audit_log',
    ]) {
      expect(TOOL_GRANT_MAP, `${tool} must be classified`).toHaveProperty(tool);
    }
  });
});
