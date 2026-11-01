/**
 * S40: historical flow versions. The Metadata API serves only a flow's
 * LATEST version; older versions exist solely as the Tooling Flow record's
 * `Metadata` field — JSON whose keys mirror the metadata XML's element
 * names. This converter turns that JSON back into Flow metadata XML so the
 * same readers (the diff tools, the flow-visualize template) consume any
 * version.
 *
 * Fidelity contract, stated honestly everywhere the output surfaces: the
 * conversion is faithful for READING and DIFFING — element names, nesting,
 * repeats, and values round-trip — but element ORDER is alphabetical by
 * key, which may differ from a Metadata API retrieve. Two converted
 * versions diff cleanly against each other; a converted version against a
 * retrieved one may show ordering-only noise; and the output is not
 * guaranteed deploy-ready byte-for-byte.
 *
 * MIRROR FILE: keep byte-identical with the desktop engine's copy
 * (packages/engine/src/salesforce/flowversion.ts).
 */

const XMLNS = 'http://soap.sforce.com/2006/04/metadata';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function serializeValue(name: string, value: unknown, indent: string): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    return value.map((item) => serializeValue(name, item, indent)).join('');
  }
  if (typeof value === 'object') {
    const inner = serializeObject(value as Record<string, unknown>, indent + '    ');
    if (inner === '') return `${indent}<${name}/>\n`;
    return `${indent}<${name}>\n${inner}${indent}</${name}>\n`;
  }
  // Primitives: booleans and numbers stringify the way the XML carries them.
  return `${indent}<${name}>${escapeXml(String(value))}</${name}>\n`;
}

function serializeObject(obj: Record<string, unknown>, indent: string): string {
  // Alphabetical key order: deterministic, and close to (not guaranteed
  // identical to) Metadata API ordering — see the fidelity contract above.
  return Object.keys(obj)
    .sort()
    .map((key) => serializeValue(key, obj[key], indent))
    .join('');
}

/** Tooling Flow.Metadata JSON → Flow metadata XML. */
export function flowMetadataJsonToXml(metadata: Record<string, unknown>): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<Flow xmlns="${XMLNS}">\n` +
    serializeObject(metadata, '    ') +
    '</Flow>\n'
  );
}
