import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createStartupErrorServer } from '../failsafe.js';
import { ContrailError } from '../core/errors.js';
import { ENGINE_VERSION } from '../core/version.js';

/**
 * The degraded-mode server exists for hosts that show no server stderr (the
 * .mcpb channel): a startup failure must complete the MCP handshake and carry
 * the error through the connection instead of dying into a silent crash loop.
 */

let client: Client;

async function connectTo(err: unknown): Promise<Client> {
  const server = createStartupErrorServer(err);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

afterEach(async () => {
  await client.close();
});

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

describe('startup-failure failsafe server', () => {
  it('completes the handshake and exposes exactly engine_status', async () => {
    await connectTo(new Error('boom'));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['engine_status']);
  });

  it('announces the failure in the server instructions', async () => {
    await connectTo(new Error('the database ate itself'));
    expect(client.getInstructions()).toContain('FAILED TO START');
    expect(client.getInstructions()).toContain('the database ate itself');
  });

  it('engine_status reports the error, code, and remediation as an error result', async () => {
    const guardErr = new ContrailError(
      'This database file is not the one this data directory last used',
      'db_lineage_mismatch',
    );
    await connectTo(guardErr);
    const result = await client.callTool({ name: 'engine_status', arguments: {} });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(textOf(result)) as {
      status: string;
      version: string;
      error: string;
      error_code?: string;
      data_dir: string;
      remediation: string[];
      stack?: string;
    };
    expect(parsed.status).toBe('startup_failed');
    expect(parsed.version).toBe(ENGINE_VERSION);
    expect(parsed.error).toContain('not the one this data directory last used');
    expect(parsed.error_code).toBe('db_lineage_mismatch');
    expect(parsed.data_dir.length).toBeGreaterThan(0);
    expect(parsed.remediation.length).toBeGreaterThan(0);
    expect(parsed.stack).toContain('ContrailError');
  });

  it('survives a non-Error throw value', async () => {
    await connectTo('string throw');
    const result = await client.callTool({ name: 'engine_status', arguments: {} });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(textOf(result)) as { error: string; error_code?: string };
    expect(parsed.error).toBe('string throw');
    expect(parsed.error_code).toBeUndefined();
  });

  it('honors CONTRAIL_DATA_DIR in the reported data_dir', async () => {
    process.env.CONTRAIL_DATA_DIR = 'X:\\contrail-test-data';
    try {
      await connectTo(new Error('boom'));
      const result = await client.callTool({ name: 'engine_status', arguments: {} });
      const parsed = JSON.parse(textOf(result)) as { data_dir: string };
      expect(parsed.data_dir).toBe('X:\\contrail-test-data');
    } finally {
      delete process.env.CONTRAIL_DATA_DIR;
    }
  });
});
