import { XMLValidator } from 'fast-xml-parser';
import { ContrailError } from '../core/errors.js';
import { asArray, parseXml } from '../salesforce/xml.js';

/**
 * The flow page builder: turns the flow-visualize skill's template plus one
 * or two flows' XML into a self-contained HTML page. Pure — no disk, no
 * network, no clock; render_flow (tools/flowrender.ts) does the reading and
 * the writing. Plugin-only.
 *
 * Why it exists: the template carries three placeholders inside an inline
 * script and a <title>. Filling them with plain string replaces is unsafe in
 * four ways — a flow label lands in <title> as markup; "</script>" or "<!--"
 * inside the XML ends the inline script; "$&" and "$1" in a replacement
 * string are interpreted; and a second replace rescans the XML the first one
 * inserted, so a flow that contains the text of a placeholder is itself
 * substituted. buildFlowPage closes all four: values are escaped for where
 * they land, and the substitution is ONE pass with a function replacer.
 */

/** The element tags the page draws as nodes — the template's ELEMENT_KINDS, pinned by test. */
export const FLOW_NODE_TAGS: readonly string[] = [
  'assignments',
  'decisions',
  'recordLookups',
  'recordCreates',
  'recordUpdates',
  'recordDeletes',
  'screens',
  'loops',
  'subflows',
  'actionCalls',
  'apexPluginCalls',
  'waits',
  'transforms',
  'collectionProcessors',
  'customErrors',
  'recordRollbacks',
  'orchestratedStages',
];

/** Above this many nodes a pane shows a plain message instead of a diagram — the template's MAX_NODES, pinned by test. */
export const FLOW_DIAGRAM_MAX_NODES = 250;

/** One side's flow XML, in bytes. Flow metadata is text; 5 MB is far past real. */
export const RENDER_MAX_FLOW_BYTES = 5_000_000;

export interface FlowPageMeta {
  aLabel: string;
  bLabel?: string;
  subtitle?: string;
  note?: string;
}

const TITLE_TOKEN = '<title>Flow Diff Viewer</title>';
const FLOW_A_TOKEN = '__FLOW_A__';
const FLOW_B_TOKEN = '__FLOW_B__';
const META_TOKEN = '__META__';
const PAGE_TOKENS = [TITLE_TOKEN, FLOW_A_TOKEN, FLOW_B_TOKEN, META_TOKEN] as const;

// U+2028 and U+2029 end a line in JavaScript source but not in JSON. They are
// built with fromCharCode so no invisible character sits in this file.
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const JS_LITERAL_ESCAPES: Record<string, string> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  [LINE_SEPARATOR]: '\\u2028',
  [PARAGRAPH_SEPARATOR]: '\\u2029',
};
const JS_LITERAL_UNSAFE = new RegExp(`[<>&${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}]`, 'g');

/**
 * A value as a JavaScript literal that is safe inside an inline <script>:
 * JSON, with `<`, `>`, `&`, U+2028 and U+2029 written as \uXXXX escapes, so
 * "</script>", "<!--" and "<script" can never appear in the script's text.
 * JSON.parse of the result gives the value back unchanged.
 */
export function jsLiteral(value: unknown): string {
  const json = JSON.stringify(value) ?? 'null';
  return json.replace(JS_LITERAL_UNSAFE, (c) => JS_LITERAL_ESCAPES[c] ?? c);
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape text for HTML element content or a quoted attribute value. */
export function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/** Drop ONE leading U+FEFF (a byte-order mark read as text), and nothing else. */
export function stripBom(xml: string): string {
  return xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
}

/**
 * Is this text something the page can draw: well-formed XML whose root is
 * <Flow>, declaring no DOCTYPE and no entity. Checked in this order:
 *
 *   1. One leading U+FEFF is ignored (callers embed the stripped text).
 *   2. Any <!DOCTYPE or <!ENTITY -> `doctype`. The page's XML parser would
 *      expand entities; flow metadata never declares them.
 *   3. After an optional XML declaration and comments, the first element must
 *      be <Flow -> otherwise `not_flow`.
 *   4. fast-xml-parser's XMLValidator must accept it -> otherwise `malformed`,
 *      with the validator's code and line.
 *   5. Faults the validator lets through are `malformed` too (bodyFault,
 *      below). None of them is well-formed XML, and the page's XML parser
 *      stops at them — at a `<` inside a tag in most spellings rather than
 *      all, so the rule kept here is XML's own, not one parser's. Code
 *      InvalidXml: a comment, CDATA section or processing instruction that
 *      is never closed (the validator accepts one after the root); anything
 *      outside the root element other than white space, comments and
 *      processing instructions — a second top-level element (the validator
 *      misses one that is self-closed, as in `<Flow>..</Flow><Flow/>`),
 *      text, a CDATA section; a comment that holds `--`; a `<!` that opens
 *      neither a comment nor a CDATA section; and a `<` inside a tag. Code
 *      UndefinedEntity: a named entity other than XML's own five (with no
 *      DOCTYPE nothing can declare one, so `&nbsp;` is undefined).
 *
 * Step 4 is here because parseXml is NOT a well-formedness check: it returns
 * an object for a flow cut off mid-element and for a mismatched closing tag
 * without throwing. Without it a truncated or retyped file would be written
 * as a page that reports success and then cannot draw. This is still not a
 * full XML conformance check (an undeclared namespace prefix passes); what
 * slips through shows as a line of text on the page, not a diagram.
 *
 * Every step reads the text a fixed number of times, so the cost grows with
 * its length and not with what it holds: this runs on a file an agent named,
 * inside the server process, before any grant is asked for.
 */
export function checkFlowXml(
  xml: string,
):
  | { ok: true }
  | { ok: false; reason: 'not_flow' | 'doctype' | 'malformed'; code?: string; line?: number } {
  const text = stripBom(xml);
  if (/<!(?:DOCTYPE|ENTITY)/i.test(text)) return { ok: false, reason: 'doctype' };

  // The prolog: whitespace, one optional XML declaration, then comments.
  let at = 0;
  const skipSpace = (): void => {
    while (at < text.length && /\s/.test(text[at] ?? '')) at += 1;
  };
  skipSpace();
  if (text.startsWith('<?xml', at)) {
    const end = text.indexOf('?>', at);
    if (end === -1) return { ok: false, reason: 'not_flow' };
    at = end + 2;
  }
  for (;;) {
    skipSpace();
    if (!text.startsWith('<!--', at)) break;
    const end = text.indexOf('-->', at + 4);
    if (end === -1) return { ok: false, reason: 'not_flow' };
    at = end + 3;
  }
  // "<Flow" followed by the end of the name — <Flows> is not a flow.
  if (!text.startsWith('<Flow', at) || !/[\s/>]/.test(text[at + 5] ?? '')) {
    return { ok: false, reason: 'not_flow' };
  }

  const verdict = XMLValidator.validate(text);
  if (verdict !== true) {
    return { ok: false, reason: 'malformed', code: verdict.err.code, line: verdict.err.line };
  }

  const fault = bodyFault(text);
  if (fault) {
    return { ok: false, reason: 'malformed', code: fault.code, line: lineAt(text, fault.at) };
  }
  return { ok: true };
}

/** The 1-based line an offset falls on. */
function lineAt(text: string, index: number): number {
  let line = 1;
  for (let nl = text.indexOf('\n'); nl !== -1 && nl < index; nl = text.indexOf('\n', nl + 1)) {
    line += 1;
  }
  return line;
}

/** A fault the validator let through: the code it is reported under, and its offset. */
interface BodyFault {
  code: 'InvalidXml' | 'UndefinedEntity';
  at: number;
}

/**
 * The first fault the validator let through (checkFlowXml, step 5), or null.
 * Called only on text the validator accepted, so the tags balance and a plain
 * depth count is enough. It is ONE left-to-right walk: comments, CDATA
 * sections and processing instructions are stepped over, so they may hold
 * any "&", and a ">" inside a quoted attribute value does not end a tag.
 *
 * The walk never goes back. A search for a closing "-->", "]]>" or "?>"
 * either finds it and moves past it, or fails once and ends the walk. (A lazy
 * `/<!--[\s\S]*?-->/g` over the same text reads to its end again for every
 * "<!--" with no "-->" after it: quadratic, minutes of a blocked server for a
 * 5 MB file of openers.) The search for an undefined entity is repeated only
 * once the walk has passed the last one it found.
 */
function bodyFault(text: string): BodyFault | null {
  const invalid = (at: number): BodyFault => ({ code: 'InvalidXml', at });

  // An "&" that does not start one of XML's own references. `entityAt` is the
  // first one at or after the start of the last search: -2 before any search,
  // -1 once there is none left.
  const undefinedEntity = /&(?!(?:lt|gt|amp|quot|apos|#[0-9]+|#x[0-9A-Fa-f]+);)/g;
  let entityAt = -2;
  const entityIn = (start: number, end: number): number => {
    if (entityAt !== -1 && entityAt < start) {
      undefinedEntity.lastIndex = start;
      entityAt = undefinedEntity.exec(text)?.index ?? -1;
    }
    return entityAt !== -1 && entityAt < end ? entityAt : -1;
  };

  let depth = 0;
  let roots = 0;
  let from = 0;
  for (;;) {
    const lt = text.indexOf('<', from);
    const textEnd = lt === -1 ? text.length : lt;
    if (depth === 0) {
      // Outside the root element, text may only be XML's white space.
      for (let i = from; i < textEnd; i += 1) {
        const c = text.charCodeAt(i);
        if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return invalid(i);
      }
    } else {
      const entity = entityIn(from, textEnd);
      if (entity !== -1) return { code: 'UndefinedEntity', at: entity };
    }
    if (lt === -1) return null;

    const comment = text.startsWith('<!--', lt);
    const cdata = text.startsWith('<![CDATA[', lt);
    const skip: [string, number] | null = comment
      ? ['-->', 4]
      : cdata
        ? [']]>', 9]
        : text.startsWith('<?', lt)
          ? ['?>', 2]
          : null;
    if (skip) {
      const end = text.indexOf(skip[0], lt + skip[1]);
      // Never closed; or a CDATA section, which is text, outside the root.
      if (end === -1 || (cdata && depth === 0)) return invalid(lt);
      // A comment may not hold "--": the first one in it must be its closer's.
      if (comment) {
        const dashes = text.indexOf('--', lt + 4);
        if (dashes !== end) return invalid(dashes);
      }
      from = end + skip[0].length;
      continue;
    }
    // With DOCTYPE and ENTITY already refused, no other "<!" is XML here.
    if (text[lt + 1] === '!') return invalid(lt);

    let end = lt + 1;
    let quote = '';
    for (; end < text.length; end += 1) {
      const c = text[end];
      // A "<" cannot stand inside a tag, in a quoted value or out of one.
      if (c === '<') return invalid(end);
      if (quote !== '') {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        break;
      }
    }
    if (end >= text.length) return invalid(lt);
    if (text[lt + 1] === '/') {
      depth -= 1;
    } else {
      if (depth === 0) {
        roots += 1;
        if (roots === 2) return invalid(lt);
      }
      // Attribute values are read for references just as text is.
      const entity = entityIn(lt, end);
      if (entity !== -1) return { code: 'UndefinedEntity', at: entity };
      if (text[end - 1] !== '/') depth += 1;
    }
    from = end + 1;
  }
}

/**
 * How many nodes the page will draw for this flow: the Start node plus every
 * element under a FLOW_NODE_TAGS tag. Advisory — it tells the caller when a
 * side is over the diagram limit and never causes a refusal. Returns null
 * when the text does not parse or has no <Flow> root.
 */
export function countFlowElements(xml: string): number | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseXml(xml);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || !Object.hasOwn(parsed, 'Flow')) return null;
  const flow = parsed.Flow;
  // An empty <Flow/> parses to a string: nothing but the Start node.
  if (flow === null || typeof flow !== 'object') return 1;
  const children = flow as Record<string, unknown>;
  let count = 1;
  for (const tag of FLOW_NODE_TAGS) count += asArray(children[tag]).length;
  return count;
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Fill the template. `xmlB: null` builds the single view (the page's
 * FLOW_B_XML is the literal null). Throws ContrailError('template_invalid')
 * unless the template carries each of the four tokens exactly once — a
 * template that does not is not the one this engine expects.
 */
export function buildFlowPage(
  template: string,
  input: { title: string; xmlA: string; xmlB: string | null; meta: FlowPageMeta },
): string {
  for (const token of PAGE_TOKENS) {
    const n = occurrences(template, token);
    if (n !== 1) {
      throw new ContrailError(
        `The flow page template does not carry ${token} exactly once (found ${n}).`,
        'template_invalid',
      );
    }
  }
  const values: Record<string, string> = {
    [TITLE_TOKEN]: `<title>${escHtml(input.title)}</title>`,
    [FLOW_A_TOKEN]: jsLiteral(input.xmlA),
    [FLOW_B_TOKEN]: input.xmlB === null ? 'null' : jsLiteral(input.xmlB),
    [META_TOKEN]: jsLiteral(input.meta),
  };
  // ONE pass, so inserted XML is never rescanned for tokens; a function
  // replacer, so "$&", "$1" and the like in a value stay literal.
  return template.replace(
    /<title>Flow Diff Viewer<\/title>|__FLOW_A__|__FLOW_B__|__META__/g,
    (m) => values[m] ?? m,
  );
}
