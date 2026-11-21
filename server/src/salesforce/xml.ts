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

/*
 * One-walk readers for XML text that may be malformed or hostile (deploy
 * content an agent supplies). Each returns exactly what the regular
 * expression in its comment returns, but the expressions take quadratic or
 * cubic time on bad input, and they run synchronously, so meanwhile every
 * tool on the server waits. `tag` is a plain element name: no regex meaning.
 */

/**
 * The `<tag>…</tag>` blocks of `text`, in order: what
 * `text.match(/<tag>[\s\S]*?<\/tag>/g) ?? []` returns. A block ends at the
 * first closer after its opener (nesting is not understood). The pattern
 * reads to the end of the text again for every opener with no closer after
 * it (quadratic: about 4 s for 40,000 openers, measured on one machine);
 * this walk stops at the first such opener, since no later opener can have
 * a closer after it either.
 */
export function xmlBlocks(text: string, tag: string): string[] {
  const blocks: string[] = [];
  forEachXmlBlock(text, tag, (start, end) => {
    blocks.push(text.slice(start, end));
  });
  return blocks;
}

/**
 * The text inside the first `<tag>…</tag>` block of `text`: what
 * `text.match(/<tag>([\s\S]*?)<\/tag>/)?.[1]` returns. Only the first opener
 * can match: if no closer follows it, none follows a later one either.
 */
export function xmlBlockText(text: string, tag: string): string | undefined {
  const open = `<${tag}>`;
  const at = text.indexOf(open);
  if (at === -1) return undefined;
  const start = at + open.length;
  const end = text.indexOf(`</${tag}>`, start);
  return end === -1 ? undefined : text.slice(start, end);
}

/** `text` less its `<tag>…</tag>` blocks: `text.replace(/<tag>[\s\S]*?<\/tag>/g, '')`. */
export function withoutXmlBlocks(text: string, tag: string): string {
  let kept = '';
  let from = 0;
  forEachXmlBlock(text, tag, (start, end) => {
    kept += text.slice(from, start);
    from = end;
  });
  return kept + text.slice(from);
}

function forEachXmlBlock(
  text: string,
  tag: string,
  visit: (start: number, end: number) => void,
): void {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  for (let from = 0; ; ) {
    const start = text.indexOf(open, from);
    if (start === -1) return;
    const at = text.indexOf(close, start + open.length);
    if (at === -1) return;
    from = at + close.length;
    visit(start, from);
  }
}

/**
 * The value of the first `<tag>value</tag>` in `text`: what
 * `text.match(/<tag>\s*([^<]+?)\s*<\/tag>/)?.[1]` returns. With `emptyOk`
 * it is the `([^<]*?)` form; with `ignoreCase`, the /i form. The pattern is
 * cubic in the white space after an opener whose value is not followed by
 * its closer (about 15 s for 4,000 spaces, measured on one machine). Its
 * answer, kept here:
 * - an opener counts only if the next "<" after it begins the closer;
 * - the value is the text in between, less the white space \s takes at
 *   either end (the same characters String.prototype.trim removes);
 * - `[^<]+?` needs one character, so an empty value is passed over, and a
 *   value of white space alone answers its last character.
 */
export function xmlTagValue(
  text: string,
  tag: string,
  opts: { emptyOk?: boolean; ignoreCase?: boolean } = {},
): string | undefined {
  // Without the u flag, /i never folds a non-ASCII character onto an ASCII
  // one, so for an ASCII tag folding A-Z alone is exact. That moves no
  // index, so the walk searches a folded copy and slices the original.
  const hay = opts.ignoreCase ? foldAsciiCase(text) : text;
  const name = opts.ignoreCase ? foldAsciiCase(tag) : tag;
  const open = `<${name}>`;
  const close = `</${name}>`;
  for (let at = hay.indexOf(open); at !== -1; ) {
    const start = at + open.length;
    const lt = hay.indexOf('<', start);
    if (lt === -1) return undefined;
    if (hay.startsWith(close, lt)) {
      const raw = text.slice(start, lt);
      const value = raw.trim();
      if (value !== '' || opts.emptyOk) return value;
      if (raw !== '') return raw.slice(-1);
    }
    at = hay.indexOf(open, lt);
  }
  return undefined;
}

/**
 * The raw text of every `<tag>text</tag>` in `text` whose text holds no "<",
 * in order: each opener's text up to the next "<", kept when that "<" begins
 * the closer. With `ignoreCase`, the tag matches as a non-unicode /i regex
 * matches an ASCII tag (see xmlTagValue). Untrimmed, empty text included.
 */
export function xmlTagTexts(
  text: string,
  tag: string,
  opts: { ignoreCase?: boolean } = {},
): string[] {
  const hay = opts.ignoreCase ? foldAsciiCase(text) : text;
  const name = opts.ignoreCase ? foldAsciiCase(tag) : tag;
  const open = `<${name}>`;
  const close = `</${name}>`;
  const texts: string[] = [];
  for (let at = hay.indexOf(open); at !== -1; ) {
    const start = at + open.length;
    const lt = hay.indexOf('<', start);
    if (lt === -1) break;
    if (hay.startsWith(close, lt)) texts.push(text.slice(start, lt));
    at = hay.indexOf(open, lt);
  }
  return texts;
}

function foldAsciiCase(s: string): string {
  return s.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
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
