import { XMLParser } from 'fast-xml-parser';

export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/**
 * Parser tuned for Salesforce SOAP/metadata XML: no attribute noise, no
 * automatic number coercion (org ids and version numbers stay strings).
 */
export function createXmlParser(): XMLParser {
  return new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    isArray: () => false,
  });
}

export function parseXml(xml: string): Record<string, unknown> {
  return createXmlParser().parse(xml) as Record<string, unknown>;
}

/** Normalize a maybe-array XML node (single child vs list) into an array. */
export function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Walk a parsed XML object down a path of keys, tolerating namespace prefixes. */
export function xmlDig(node: unknown, ...path: string[]): unknown {
  let current: unknown = node;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    const obj = current as Record<string, unknown>;
    if (key in obj) {
      current = obj[key];
      continue;
    }
    // tolerate soapenv:/mns: style prefixes
    const match = Object.keys(obj).find((k) => k === key || k.endsWith(`:${key}`));
    if (!match) return undefined;
    current = obj[match];
  }
  return current;
}
