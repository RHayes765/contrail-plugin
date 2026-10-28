// Synced from package.json by scripts/release.mjs — do not hand-edit.
export const ENGINE_VERSION = '0.32.0';

// Lives here (not server.ts) so failsafe.ts can name the server without
// importing the engine module graph — see the import discipline note there.
export const SERVER_NAME = 'contrail-engine';
