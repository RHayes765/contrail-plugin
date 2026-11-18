import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { ContrailError } from '../core/errors.js';
import { flowMetadataJsonToXml } from '../salesforce/flowversion.js';
import {
  buildFlowPage,
  checkFlowXml,
  countFlowElements,
  escHtml,
  FLOW_DIAGRAM_MAX_NODES,
  FLOW_NODE_TAGS,
  jsLiteral,
  RENDER_MAX_FLOW_BYTES,
  stripBom,
  type FlowPageMeta,
} from '../skillpack/flowpage.js';
import * as fixtures from './fixtures.js';
import { SEND_INVOICE_FLOW_XML } from './fixtures.js';

/**
 * The flow page builder (skillpack/flowpage.ts) and the template it fills
 * (skills/salesforce-flow-visualize/assets/flow-diff-template.html).
 *
 * The builder puts org-controlled text — flow XML, labels — into an inline
 * script and a <title>. These tests pin that nothing in that text can end the
 * script, start markup, or be mistaken for a placeholder, and that the
 * shipped template stays free of HTML-string sinks and network references.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const TEMPLATE_PATH = path.join(
  repoRoot,
  'skills',
  'salesforce-flow-visualize',
  'assets',
  'flow-diff-template.html',
);
const TEMPLATE = fs.readFileSync(TEMPLATE_PATH, 'utf8');

const TOKENS = ['<title>Flow Diff Viewer</title>', '__FLOW_A__', '__FLOW_B__', '__META__'];

const BOM = '\uFEFF';
const LS = '\u2028';
const PS = '\u2029';

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** The text of the page's one inline script. */
function inlineScript(page: string): string {
  const open = page.indexOf('<script>');
  const close = page.indexOf('</script>');
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return page.slice(open + '<script>'.length, close);
}

/** The three literals the builder wrote into the script, as source text. */
function literals(page: string): { a: string; b: string; meta: string } {
  const pick = (name: string): string => {
    const m = new RegExp(`^const ${name} = (.*);$`, 'm').exec(page);
    expect(m, `the ${name} line`).not.toBeNull();
    return m![1]!;
  };
  return { a: pick('FLOW_A_XML'), b: pick('FLOW_B_XML'), meta: pick('META') };
}

function build(input: { title?: string; xmlA: string; xmlB?: string | null; meta?: FlowPageMeta }): string {
  return buildFlowPage(TEMPLATE, {
    title: input.title ?? 'A flow',
    xmlA: input.xmlA,
    xmlB: input.xmlB ?? null,
    meta: input.meta ?? { aLabel: 'left' },
  });
}

describe('jsLiteral and escHtml', () => {
  it('jsLiteral round-trips through JSON.parse and leaves no <, > or & in its text', () => {
    const value = `<a href="x">&amp;</a></script><!-- ${LS}${PS} "quoted" \\ back`;
    const literal = jsLiteral(value);
    expect(JSON.parse(literal)).toBe(value);
    expect(literal).not.toMatch(/[<>&\u2028\u2029]/);
    expect(literal).toContain('\\u003c/script\\u003e');
    expect(literal).toContain('\\u2028\\u2029');
  });

  it('jsLiteral handles objects, null and undefined', () => {
    expect(JSON.parse(jsLiteral({ aLabel: '<b>', note: 'x & y' }))).toEqual({ aLabel: '<b>', note: 'x & y' });
    expect(jsLiteral(null)).toBe('null');
    expect(jsLiteral(undefined)).toBe('null');
  });

  it('escHtml escapes the five characters', () => {
    expect(escHtml(`& < > " '`)).toBe('&amp; &lt; &gt; &quot; &#39;');
    expect(escHtml('plain text')).toBe('plain text');
  });
});

describe('buildFlowPage: hostile input survives, byte for byte', () => {
  const HOSTILE: Array<[string, string]> = [
    ['a closing script tag and a new script', '</script><script>alert(1)</script>'],
    ['an HTML comment opener', '<!-- never closed'],
    ['$& (the whole match, in a replacement string)', 'cost: $& and more'],
    ['$1 (a capture group, in a replacement string)', 'cost: $1 and $2'],
    ['$` (the text before the match)', 'cost: $` and more'],
    ["$' (the text after the match)", "cost: $' and more"],
    ['the text of the side-B placeholder', 'see __FLOW_B__ here'],
    ['the text of the META placeholder', 'see __META__ here'],
    ['the text of the side-A placeholder', 'see __FLOW_A__ here'],
    ['the template title', '<title>Flow Diff Viewer</title>'],
    ['U+2028', `line${LS}separator`],
    ['U+2029', `paragraph${PS}separator`],
    ['quotes, backslashes and newlines', `"double" 'single' \\ back\nnew line\r\n\ttab`],
  ];

  for (const [what, hostile] of HOSTILE) {
    it(`${what}`, () => {
      const xmlA = `<Flow><label>${hostile}</label></Flow>`;
      const xmlB = `<Flow><description>${hostile}</description><label>B</label></Flow>`;
      const meta: FlowPageMeta = {
        aLabel: `A ${hostile}`,
        bLabel: `B ${hostile}`,
        subtitle: `sub ${hostile}`,
        note: `note ${hostile}`,
      };
      const page = build({ title: `T ${hostile}`, xmlA, xmlB, meta });

      const found = literals(page);
      expect(JSON.parse(found.a)).toBe(xmlA);
      expect(JSON.parse(found.b)).toBe(xmlB);
      expect(JSON.parse(found.meta)).toEqual(meta);

      // Nothing in the values ended the script or opened another.
      expect(count(page, '</script>')).toBe(1);
      expect(count(page.toLowerCase(), '</script')).toBe(1);
      expect(count(page.toLowerCase(), '<script')).toBe(1);
      expect(count(page, '<title>')).toBe(1);
      expect(count(page, '</title>')).toBe(1);
      // The inline script is still one parsable program.
      expect(() => new vm.Script(inlineScript(page))).not.toThrow();
      // Everything outside the four substitutions is the template, untouched.
      expect(page.startsWith(TEMPLATE.slice(0, TEMPLATE.indexOf('<title>')))).toBe(true);
      expect(page.endsWith(TEMPLATE.slice(TEMPLATE.indexOf('/* ================= parsing')))).toBe(true);
    });
  }

  it('all of them at once, on both sides', () => {
    const everything = HOSTILE.map(([, h]) => h).join(' | ');
    const xmlA = `<Flow><label>${everything}</label></Flow>`;
    const xmlB = `<Flow><label>B ${everything}</label></Flow>`;
    const page = build({ title: everything, xmlA, xmlB, meta: { aLabel: everything, bLabel: 'b' } });
    const found = literals(page);
    expect(JSON.parse(found.a)).toBe(xmlA);
    expect(JSON.parse(found.b)).toBe(xmlB);
    expect(JSON.parse(found.meta)).toEqual({ aLabel: everything, bLabel: 'b' });
    expect(count(page, '</script>')).toBe(1);
    expect(() => new vm.Script(inlineScript(page))).not.toThrow();
  });

  it('inserted XML is never rescanned: a side that names the other placeholders is embedded as given', () => {
    const xmlA = '<Flow><label>__FLOW_B__ __META__ __FLOW_A__</label></Flow>';
    const page = build({ xmlA, xmlB: '<Flow><label>the real B</label></Flow>', meta: { aLabel: 'L', bLabel: 'R' } });
    const found = literals(page);
    expect(JSON.parse(found.a)).toBe(xmlA);
    expect(JSON.parse(found.b)).toBe('<Flow><label>the real B</label></Flow>');
    expect(JSON.parse(found.meta)).toEqual({ aLabel: 'L', bLabel: 'R' });
  });

  it('a real flow fixture is embedded exactly', () => {
    const page = build({ xmlA: SEND_INVOICE_FLOW_XML, xmlB: SEND_INVOICE_FLOW_XML });
    const found = literals(page);
    expect(JSON.parse(found.a)).toBe(SEND_INVOICE_FLOW_XML);
    expect(JSON.parse(found.b)).toBe(SEND_INVOICE_FLOW_XML);
  });
});

describe('buildFlowPage: title, single view, template tokens', () => {
  it('escapes a title that tries to close the element', () => {
    const page = build({ title: '</title><script>x</script>', xmlA: '<Flow/>' });
    expect(page).toContain('<title>&lt;/title&gt;&lt;script&gt;x&lt;/script&gt;</title>');
    expect(count(page, '<title>')).toBe(1);
    expect(count(page, '</title>')).toBe(1);
    expect(count(page, '</script>')).toBe(1);
    expect(count(page, '<script>')).toBe(1);
    expect(page).not.toContain('<title>Flow Diff Viewer</title>');
  });

  it('escapes quotes and ampersands in a title', () => {
    const page = build({ title: `Fees & "Credits" 'v2'`, xmlA: '<Flow/>' });
    expect(page).toContain('<title>Fees &amp; &quot;Credits&quot; &#39;v2&#39;</title>');
  });

  it('xmlB: null yields the literal null', () => {
    const page = build({ xmlA: '<Flow/>', xmlB: null });
    expect(literals(page).b).toBe('null');
    expect(page).toContain('\nconst FLOW_B_XML = null;\n');
  });

  it('an empty string on side B is a string, not null', () => {
    expect(literals(build({ xmlA: '<Flow/>', xmlB: '' })).b).toBe('""');
  });

  for (const token of TOKENS) {
    it(`a template without ${token} throws template_invalid`, () => {
      const broken = TEMPLATE.replace(token, 'gone');
      expect(count(broken, token)).toBe(0);
      let thrown: unknown;
      try {
        buildFlowPage(broken, { title: 't', xmlA: '<Flow/>', xmlB: null, meta: { aLabel: 'a' } });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ContrailError);
      expect((thrown as ContrailError).code).toBe('template_invalid');
    });

    it(`a template with ${token} twice throws template_invalid`, () => {
      const doubled = `${TEMPLATE}\n<!-- ${token} -->\n`;
      expect(count(doubled, token)).toBe(2);
      let thrown: unknown;
      try {
        buildFlowPage(doubled, { title: 't', xmlA: '<Flow/>', xmlB: null, meta: { aLabel: 'a' } });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ContrailError);
      expect((thrown as ContrailError).code).toBe('template_invalid');
    });
  }

  it('text that is not the template at all throws template_invalid', () => {
    expect(() =>
      buildFlowPage('<p>hello</p>', { title: 't', xmlA: '<Flow/>', xmlB: null, meta: { aLabel: 'a' } }),
    ).toThrowError(ContrailError);
  });
});

describe('the shipped template', () => {
  it('opens with the doctype, the charset, the policy, the title and the viewport line, verbatim', () => {
    expect(
      TEMPLATE.startsWith(
        [
          '<!doctype html>',
          '<meta charset="utf-8">',
          `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">`,
          '<title>Flow Diff Viewer</title>',
          '<meta name="claude:viewport-fit-sides" content="cover">',
          '<style>',
        ].join('\n'),
      ),
    ).toBe(true);
  });

  it('declares its charset within the first 200 bytes', () => {
    const head = Buffer.from(TEMPLATE, 'utf8').subarray(0, 200).toString('utf8');
    expect(head).toContain('<meta charset="utf-8">');
  });

  it("carries a Content-Security-Policy whose default-src is 'none'", () => {
    const m = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(TEMPLATE);
    expect(m).not.toBeNull();
    expect(m![1]).toContain("default-src 'none'");
    // No source expression lets a network origin in.
    expect(m![1]).not.toMatch(/https?:|\*/);
  });

  it('references nothing on the network', () => {
    expect(TEMPLATE).not.toContain('fonts.googleapis');
    expect(TEMPLATE.toLowerCase()).not.toContain('<link');
    const urls = TEMPLATE.match(/https?:\/\/[^\s'"<>)]*/gi) ?? [];
    expect(urls.length).toBeGreaterThan(0); // the SVG namespace
    for (const url of urls) {
      expect(url.startsWith('http://www.w3.org/'), url).toBe(true);
    }
  });

  it('has no HTML-string sink and no code-from-string call', () => {
    for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) {
      expect(TEMPLATE, banned).not.toContain(banned);
    }
  });

  it('carries each placeholder exactly once', () => {
    for (const token of TOKENS) expect(count(TEMPLATE, token), token).toBe(1);
  });

  it('has exactly one inline script, which parses', () => {
    expect(count(TEMPLATE, '<script>')).toBe(1);
    expect(count(TEMPLATE.toLowerCase(), '<script')).toBe(1);
    expect(count(TEMPLATE, '</script>')).toBe(1);
    const page = build({ xmlA: SEND_INVOICE_FLOW_XML });
    expect(() => new vm.Script(inlineScript(page))).not.toThrow();
  });

  it('shows text instead of a blank page when the flow cannot be drawn', () => {
    const script = inlineScript(TEMPLATE);
    const tryAt = script.indexOf('\ntry {\n');
    const firstParse = script.indexOf('const A = parseFlowGraph(FLOW_A_XML);');
    const catchAt = script.indexOf('\n} catch (err) {\n');
    expect(tryAt).toBeGreaterThan(-1);
    // The first parse and everything after it run inside the try.
    expect(firstParse).toBeGreaterThan(tryAt);
    expect(catchAt).toBeGreaterThan(firstParse);
    const handler = script.slice(catchAt);
    expect(handler).toContain("document.getElementById('flow-title').textContent = 'Flow page could not be drawn';");
    expect(handler).toContain("document.getElementById('footnote').textContent =");
    // Nothing follows the handler: the try covers the rest of the script.
    expect(handler.trimEnd().endsWith('}')).toBe(true);
    expect(count(handler, '\n}')).toBe(2);
  });
});

describe('the shipped template: a connector whose target no element defines', () => {
  // The page's own code, run outside a browser: these parts of the script
  // touch no DOM (layout, planEdges) or only a few elements (select).
  const SCRIPT = inlineScript(TEMPLATE);

  interface Planned {
    drawn: Array<{ path: string; label: string | null }>;
    pills: Array<{ text: string; target: string }>;
  }

  /** layout() then planEdges(), as renderPane calls them, on a graph shaped like parseFlowGraph's. */
  function plan(nodes: string[], edges: Array<[from: string, to: string, label?: string]>): Planned {
    const from = SCRIPT.indexOf('/* ========== layout');
    const to = SCRIPT.indexOf('/* ================= render');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const run = vm.runInNewContext(
      [
        // What the section reads from earlier in the script.
        "const edgeKey = (e) => e.from + '|' + e.to + '|' + (e.label || '');",
        'const edgesA = new Set();',
        SCRIPT.slice(from, to),
        '(graph) => {',
        '  graph.byName = new Map(graph.nodes.map((n) => [n.name, n]));',
        '  const { placed, depth, stacks } = layout(graph);',
        '  const { drawn, pills } = planEdges(graph, placed, depth, stacks, edgesA, edgesA);',
        '  return JSON.stringify({ drawn, pills });',
        '};',
      ].join('\n'),
    ) as (graph: unknown) => string;
    return JSON.parse(
      run({
        nodes: ['__start', ...nodes].map((name) => ({ name, label: name, kind: 'assignment', detail: null, props: [] })),
        edges: edges.map(([f, t, label]) => ({ from: f, to: t, kind: 'normal', label: label ?? null })),
      }),
    ) as Planned;
  }

  it('a flow with no dangling connector draws every edge', () => {
    const { drawn, pills } = plan(['A', 'B'], [['__start', 'A'], ['A', 'B']]);
    expect(drawn).toHaveLength(2);
    expect(pills).toEqual([]);
  });

  it('the dangling connector is left out and the rest is drawn', () => {
    // Before the guard in planEdges this threw: reading "x" of an element that has no place.
    const { drawn, pills } = plan(['A'], [['__start', 'A'], ['A', 'Missing']]);
    expect(drawn).toHaveLength(1);
    expect(pills).toEqual([]);
  });

  it('a start connector that points at nothing leaves the nodes drawn', () => {
    const { drawn, pills } = plan(['A'], [['__start', 'Gone']]);
    expect(drawn).toEqual([]);
    expect(pills).toEqual([]);
  });

  it('a decision with one real outcome and one missing keeps the real one, with its label', () => {
    const { drawn } = plan(['D', 'A'], [['__start', 'D'], ['D', 'A', 'Yes'], ['D', 'Missing', 'No']]);
    expect(drawn.map((e) => e.label)).toEqual([null, 'Yes']);
  });

  it('a second connector to the same missing target, from another row, is a go-to pill', () => {
    const { drawn, pills } = plan(['A', 'B'], [['__start', 'A'], ['A', 'B'], ['A', 'Missing'], ['B', 'Missing']]);
    expect(drawn).toHaveLength(2);
    expect(pills.map((p) => [p.text, p.target])).toEqual([['→ Missing', 'Missing']]);
  });

  it('selecting such a target (its go-to pill) shows the empty inspector instead of throwing', () => {
    const from = SCRIPT.indexOf('function select(name) {');
    const to = SCRIPT.indexOf("document.getElementById('insp-close')");
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const state = vm.runInNewContext(
      [
        "const els = { 'insp-empty': { hidden: true }, 'insp-body': { hidden: false } };",
        'const document = { querySelectorAll: () => [], getElementById: (id) => els[id] };',
        'const A = { byName: new Map(), resources: new Map() };',
        'const B = null, DIFF = false;',
        SCRIPT.slice(from, to),
        "select('Missing');",
        "JSON.stringify({ empty: els['insp-empty'].hidden, body: els['insp-body'].hidden });",
      ].join('\n'),
    ) as string;
    expect(JSON.parse(state)).toEqual({ empty: false, body: true });
  });

  it('the footer names unresolved targets', () => {
    expect(SCRIPT).toContain("unresolved.length ? 'Unresolved connector targets: ' + unresolved.join(', ') : ''");
  });
});

describe('parity between the template and the builder', () => {
  it("FLOW_NODE_TAGS is the template's ELEMENT_KINDS tag list", () => {
    const block = /const ELEMENT_KINDS = \[([\s\S]*?)\n\];/.exec(TEMPLATE);
    expect(block).not.toBeNull();
    const tags = [...block![1]!.matchAll(/\['([A-Za-z]+)','[A-Za-z]+'\]/g)].map((m) => m[1]);
    expect(tags).toHaveLength(17);
    expect(tags).toEqual([...FLOW_NODE_TAGS]);
  });

  it("FLOW_DIAGRAM_MAX_NODES is the template's MAX_NODES", () => {
    const m = /\bMAX_NODES = (\d+)/.exec(TEMPLATE);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(FLOW_DIAGRAM_MAX_NODES);
    expect(FLOW_DIAGRAM_MAX_NODES).toBe(250);
  });

  it('the per-side size limit is 5,000,000 bytes', () => {
    expect(RENDER_MAX_FLOW_BYTES).toBe(5_000_000);
  });
});

describe('checkFlowXml', () => {
  const FLOW = '<Flow xmlns="http://soap.sforce.com/2006/04/metadata"><label>x</label></Flow>';

  it('accepts a byte-order mark, an XML declaration and comments before <Flow', () => {
    expect(
      checkFlowXml(`${BOM}<?xml version="1.0" encoding="UTF-8"?>\n<!-- exported -->\n<!-- twice -->\n${FLOW}\n`),
    ).toEqual({ ok: true });
    expect(checkFlowXml(FLOW)).toEqual({ ok: true });
    expect(checkFlowXml(`\n  ${FLOW}`)).toEqual({ ok: true });
    expect(checkFlowXml('<Flow/>')).toEqual({ ok: true });
  });

  it('a different root element is not_flow', () => {
    expect(checkFlowXml('<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><label>x</label></CustomObject>')).toEqual({
      ok: false,
      reason: 'not_flow',
    });
    expect(checkFlowXml('<?xml version="1.0"?>\n<FlowDefinition><activeVersionNumber>0</activeVersionNumber></FlowDefinition>')).toEqual({
      ok: false,
      reason: 'not_flow',
    });
    expect(checkFlowXml('<Flows><label>x</label></Flows>')).toEqual({ ok: false, reason: 'not_flow' });
    expect(checkFlowXml('<flow><label>x</label></flow>')).toEqual({ ok: false, reason: 'not_flow' });
  });

  it('text that is not XML is not_flow', () => {
    expect(checkFlowXml('just some words about a flow')).toEqual({ ok: false, reason: 'not_flow' });
    expect(checkFlowXml('')).toEqual({ ok: false, reason: 'not_flow' });
    expect(checkFlowXml('{"label":"Tooling JSON, not XML"}')).toEqual({ ok: false, reason: 'not_flow' });
    expect(checkFlowXml('<?xml version="1.0"')).toEqual({ ok: false, reason: 'not_flow' });
    expect(checkFlowXml('<!-- only a comment')).toEqual({ ok: false, reason: 'not_flow' });
  });

  it('a DOCTYPE or an entity declaration is doctype, wherever it sits', () => {
    expect(checkFlowXml(`<?xml version="1.0"?>\n<!DOCTYPE Flow>\n${FLOW}`)).toEqual({ ok: false, reason: 'doctype' });
    expect(
      checkFlowXml(`<!DOCTYPE Flow [ <!ENTITY big "aaaaaaaaaa"> ]>\n<Flow><label>&big;</label></Flow>`),
    ).toEqual({ ok: false, reason: 'doctype' });
    expect(checkFlowXml('<Flow><!ENTITY x "y"><label>x</label></Flow>')).toEqual({ ok: false, reason: 'doctype' });
    expect(checkFlowXml(`<!doctype html>${FLOW}`)).toEqual({ ok: false, reason: 'doctype' });
    // Checked before the root element: a page of HTML is refused for its doctype.
    expect(checkFlowXml('<!DOCTYPE html><html><body>hi</body></html>')).toEqual({ ok: false, reason: 'doctype' });
  });

  it('a flow cut off mid-element is malformed, with a code and a line', () => {
    const cut =
      '<Flow xmlns="x"><decisions><name>A</name></decisions><assignments><name>B</name><label>cut off he';
    const verdict = checkFlowXml(cut);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.reason).toBe('malformed');
    expect(typeof verdict.code).toBe('string');
    expect(verdict.code!.length).toBeGreaterThan(0);
    expect(typeof verdict.line).toBe('number');
    expect(verdict.line).toBeGreaterThanOrEqual(1);
  });

  it('a mismatched closing tag is malformed, and the line is where it happened', () => {
    const verdict = checkFlowXml('<Flow>\n<label>x</label>\n<status>Active</statis>\n</Flow>');
    expect(verdict).toMatchObject({ ok: false, reason: 'malformed' });
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.code).toBe('InvalidTag');
    expect(verdict.line).toBe(3);
  });

  it('other faults a retyped file picks up are malformed too', () => {
    expect(checkFlowXml('<Flow><label>Fees & Credits</label></Flow>')).toMatchObject({ ok: false, reason: 'malformed' });
    expect(checkFlowXml('<Flow><label>x</label>')).toMatchObject({ ok: false, reason: 'malformed' });
    expect(checkFlowXml('<Flow><label>x</label></Flow>\n<Flow><label>y</label></Flow>')).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
    expect(checkFlowXml('<Flow><label>x</label></Flow>\ntrailing words')).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('a second top-level element is malformed even when it is self-closed (the validator alone accepts it)', () => {
    expect(checkFlowXml('<Flow><label>x</label></Flow>\n<Flow/>')).toEqual({
      ok: false,
      reason: 'malformed',
      code: 'InvalidXml',
      line: 2,
    });
    expect(checkFlowXml('<Flow/><extra/>')).toEqual({ ok: false, reason: 'malformed', code: 'InvalidXml', line: 1 });
    expect(checkFlowXml('<Flow>\n<label>x</label>\n</Flow>\n\n<!-- note -->\n<extra a="1>2"/>')).toEqual({
      ok: false,
      reason: 'malformed',
      code: 'InvalidXml',
      line: 6,
    });
  });

  it('one root is one root: comments, CDATA, processing instructions and ">" in attributes do not count', () => {
    for (const xml of [
      '<Flow><label>x</label></Flow>\n<!-- <Flow/> in a trailing comment -->\n',
      '<Flow><label><![CDATA[ </Flow><Flow/> ]]></label></Flow>',
      '<Flow><label>x</label></Flow><?note <x/> ?>',
      '<Flow><value note="a > b" other=\'/Flow> and "/>\'/><label>x</label></Flow>',
      '<Flow><a/><b><c/></b><a/></Flow>',
      '<Flow\n  xmlns="http://soap.sforce.com/2006/04/metadata"\n>\n<label>x</label>\n</Flow\n>',
      // What may follow the root: white space, comments, processing instructions.
      '<Flow/>\r\n\t \n<!-- one --><?note two ?>\n<!-- three: <![CDATA[ <? <Flow/> ]]> ?> -->\n',
    ]) {
      expect(checkFlowXml(xml), xml).toEqual({ ok: true });
    }
  });

  it('a comment, CDATA section or processing instruction that is never closed is malformed (the validator alone accepts it)', () => {
    const INVALID = { ok: false, reason: 'malformed', code: 'InvalidXml' };
    expect(checkFlowXml('<Flow/><!-- never closed')).toEqual({ ...INVALID, line: 1 });
    expect(checkFlowXml('<Flow/><?pi')).toEqual({ ...INVALID, line: 1 });
    expect(checkFlowXml('<Flow/><![CDATA[ never closed')).toEqual({ ...INVALID, line: 1 });
    // After a root with content, and the line is the opener's.
    expect(checkFlowXml('<Flow>\n<label>x</label>\n</Flow>\n<!-- a note -->\n<!-- never closed\n\n')).toEqual({
      ...INVALID,
      line: 5,
    });
    expect(checkFlowXml('<Flow><label>x</label></Flow>\n<?note never closed')).toEqual({ ...INVALID, line: 2 });
    // An opener is not its own closer.
    expect(checkFlowXml('<Flow/><!-->')).toEqual({ ...INVALID, line: 1 });
    expect(checkFlowXml('<Flow/><?>')).toEqual({ ...INVALID, line: 1 });
    // Inside the root the validator reports it first, as an unclosed tag.
    expect(checkFlowXml('<Flow><label>x</label><!-- never closed')).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('text or a CDATA section outside the root is malformed (the validator alone accepts it)', () => {
    const INVALID = { ok: false, reason: 'malformed', code: 'InvalidXml' };
    expect(checkFlowXml('<Flow/>trailing words')).toEqual({ ...INVALID, line: 1 });
    expect(checkFlowXml('<Flow/>\n\n  trailing words')).toEqual({ ...INVALID, line: 3 });
    expect(checkFlowXml('<Flow/>&amp;')).toEqual({ ...INVALID, line: 1 });
    expect(checkFlowXml('<Flow><label>x</label></Flow><![CDATA[ after ]]>')).toEqual({ ...INVALID, line: 1 });
    expect(checkFlowXml('<Flow/>\n<![CDATA[ after ]]>')).toEqual({ ...INVALID, line: 2 });
    // Only XML's white space counts as white space there.
    expect(checkFlowXml('<Flow/>\f')).toEqual({ ...INVALID, line: 1 });
  });

  it('a "<" inside a tag, and a "<!" that opens neither a comment nor CDATA, are malformed', () => {
    const INVALID = { ok: false, reason: 'malformed', code: 'InvalidXml' };
    expect(checkFlowXml('<Flow><value other=\'</Flow>\'/><label>x</label></Flow>')).toEqual({ ...INVALID, line: 1 });
    expect(checkFlowXml('<Flow>\n<a b="<!--"/>\n</Flow>')).toEqual({ ...INVALID, line: 2 });
    expect(checkFlowXml('<Flow>\n<a b="<!--" c="-->"/>\n</Flow>')).toEqual({ ...INVALID, line: 2 });
    expect(checkFlowXml('<Flow>\n\n<!x>\n<label>x</label></Flow>')).toEqual({ ...INVALID, line: 3 });
    expect(checkFlowXml('<Flow/><!ELEMENT x>')).toEqual({ ...INVALID, line: 1 });
  });

  it('a comment that holds "--" is malformed, before the root, inside it or after it', () => {
    const INVALID = { ok: false, reason: 'malformed', code: 'InvalidXml' };
    expect(checkFlowXml('<Flow>\n<!-- to do -- later -->\n<label>x</label></Flow>')).toEqual({ ...INVALID, line: 2 });
    expect(checkFlowXml('<!-- saved -- by hand -->\n<Flow/>')).toEqual({ ...INVALID, line: 1 });
    expect(checkFlowXml('<Flow/>\n\n<!-- one\n -- two -->')).toEqual({ ...INVALID, line: 4 });
    expect(checkFlowXml('<Flow><!-- ends with a dash ---></Flow>')).toEqual({ ...INVALID, line: 1 });
    expect(checkFlowXml('<Flow><!-- <!-- nested --></Flow>')).toEqual({ ...INVALID, line: 1 });
    // Single dashes are fine, and so is an empty comment.
    expect(checkFlowXml('<Flow><!-- a - b - c --><!----><!-- - --><label>x</label></Flow>')).toEqual({ ok: true });
  });

  it('the cost grows with the length of the text, not with what it holds', () => {
    // A lazy /<!--[\s\S]*?-->/ reads to the end of the text once per opener
    // that is never closed: over a minute for the first of these.
    const MB = 1_000_000;
    const shapes: Array<[string, string, boolean]> = [
      ['"<!--" repeated after the root', `<Flow/>${'<!--'.repeat(MB / 4)}`, false],
      ['"<![CDATA[" repeated after the root', `<Flow/>${'<![CDATA['.repeat(MB / 9)}`, false],
      ['"<?" repeated after the root', `<Flow><label>x</label></Flow>${'<?'.repeat(MB / 2)}`, false],
      ['"<!--" in attribute values', `<Flow>${'<a b="<!--"/>'.repeat(MB / 13)}</Flow>`, false],
      ['"<!--" repeated inside one closed comment', `<Flow/><!--${'<!--'.repeat(MB / 4)}-->`, false],
      ['one closed comment full of other openers', `<Flow/><!--${'<![CDATA[<?'.repeat(MB / 11)}-->`, true],
      ['closed comments, each holding a bare "&"', `<Flow>${'<!-- & --><a>t</a>'.repeat(MB / 18)}</Flow>`, true],
      ['elements with no "&" anywhere', `<Flow>${'<a>t</a>'.repeat(MB / 8)}</Flow>`, true],
    ];
    for (const [what, xml, ok] of shapes) {
      const started = performance.now();
      const verdict = checkFlowXml(xml);
      const took = performance.now() - started;
      expect(verdict.ok, what).toBe(ok);
      if (!verdict.ok) expect(verdict, what).toMatchObject({ reason: 'malformed', code: 'InvalidXml', line: 1 });
      expect(took, `${what}: ${Math.round(took)} ms`).toBeLessThan(1000);
    }
  });

  it('a named entity XML does not define is malformed (the validator alone accepts it)', () => {
    expect(checkFlowXml('<Flow>\n<label>Fees&nbsp;and credits</label>\n</Flow>')).toEqual({
      ok: false,
      reason: 'malformed',
      code: 'UndefinedEntity',
      line: 2,
    });
    expect(checkFlowXml('<Flow><label>&copy; 2026</label></Flow>')).toMatchObject({
      ok: false,
      reason: 'malformed',
      code: 'UndefinedEntity',
    });
    // In an attribute value too, where the validator accepts even a bare "&".
    expect(checkFlowXml('<Flow>\n<a/>\n<value note="fees&nbsp;and credits"/>\n</Flow>')).toEqual({
      ok: false,
      reason: 'malformed',
      code: 'UndefinedEntity',
      line: 3,
    });
    expect(checkFlowXml("<Flow><value note='fees & credits'/></Flow>")).toMatchObject({
      ok: false,
      reason: 'malformed',
      code: 'UndefinedEntity',
    });
    // One that follows comments holding others is still found, on its own line.
    expect(
      checkFlowXml('<Flow>\n<!-- &a; -->\n<a>&amp;</a>\n<!-- & -->\n<![CDATA[ &b; ]]>\n<b>&zz;</b>\n</Flow>'),
    ).toEqual({ ok: false, reason: 'malformed', code: 'UndefinedEntity', line: 6 });
  });

  it("XML's own five entities and character references pass, and so does any & inside a comment, CDATA or a processing instruction", () => {
    for (const xml of [
      '<Flow><label>&lt;b&gt; &amp; &quot;q&quot; &apos;a&apos;</label></Flow>',
      '<Flow><label>&#38; &#x26; &#xA0; &#160;</label></Flow>',
      '<Flow><label>&amp;nbsp; is how a retrieve writes it</label></Flow>',
      '<Flow><!-- fees&nbsp;& credits --><label>x</label></Flow>',
      '<Flow><label><![CDATA[ fees&nbsp;& credits ]]></label></Flow>',
      '<Flow><?note fees&nbsp;& credits ?><label>x</label></Flow>',
      '<Flow><value note="&lt;b&gt; &amp; &#38; &quot;"/><!-- & --><label>&amp;</label><!-- &x; --></Flow>',
    ]) {
      expect(checkFlowXml(xml), xml).toEqual({ ok: true });
    }
  });
});

describe('checkFlowXml does not refuse real flow XML', () => {
  it('every flow fixture in fixtures.ts passes', () => {
    const flows = (Object.entries(fixtures) as Array<[string, unknown]>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && /<Flow[\s>]/.test(entry[1]),
    );
    expect(flows.map(([name]) => name)).toContain('SEND_INVOICE_FLOW_XML');
    for (const [name, xml] of flows) {
      expect(checkFlowXml(xml), name).toEqual({ ok: true });
    }
  });

  it('the flow shapes the other suites write inline pass', () => {
    const shapes: Record<string, string> = {
      // A record-triggered flow with a start block and top-level facts.
      'record-triggered': `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <decisions>
        <name>Is_Open</name>
        <label>Is it open?</label>
        <defaultConnectorLabel>No</defaultConnectorLabel>
        <rules>
            <name>Open</name>
            <conditionLogic>and</conditionLogic>
            <conditions>
                <leftValueReference>$Record.Status__c</leftValueReference>
                <operator>EqualTo</operator>
                <rightValue><stringValue>Open &amp; waiting</stringValue></rightValue>
            </conditions>
            <connector><targetReference>Step_One</targetReference></connector>
            <label>Open</label>
        </rules>
    </decisions>
    <label>Invoice After Save</label>
    <processMetadataValues>
        <name>ObjectType</name>
        <value><stringValue>Account</stringValue></value>
    </processMetadataValues>
    <processType>AutoLaunchedFlow</processType>
    <start>
        <locationX>50</locationX>
        <connector><targetReference>Is_Open</targetReference></connector>
        <object>Invoice__c</object>
        <recordTriggerType>CreateAndUpdate</recordTriggerType>
        <triggerType>RecordAfterSave</triggerType>
    </start>
    <status>Active</status>
</Flow>`,
      // No declaration, no namespace, one line.
      'one-line': '<Flow><label>Send Alert</label><object>Contact</object></Flow>',
      'self-closed': '<Flow/>',
      // A formula with escaped markup and a CDATA-free text template.
      formula:
        '<Flow xmlns="http://soap.sforce.com/2006/04/metadata"><formulas><name>F</name>' +
        '<expression>IF({!Amount} &lt; 0, &quot;neg&quot;, &apos;pos&apos;)</expression></formulas>' +
        '<textTemplates><name>T</name><text>&lt;p&gt;Hello {!Name}&lt;/p&gt;</text></textTemplates></Flow>',
      // Large: 4,000 repeated elements.
      large: `<?xml version="1.0" encoding="UTF-8"?>\n<Flow>${'<decisions><name>D</name></decisions>'.repeat(4000)}</Flow>`,
      // Non-ASCII text.
      unicode: '<?xml version="1.0"?>\n<Flow><label>Bíg — flow → 流程</label></Flow>',
    };
    for (const [name, xml] of Object.entries(shapes)) {
      expect(checkFlowXml(xml), name).toEqual({ ok: true });
    }
  });

  it('what flowMetadataJsonToXml produces from the conversion fixtures passes', () => {
    // The Tooling Flow.Metadata shapes flowversion.test.ts converts.
    const conversions: Array<Record<string, unknown>> = [
      {
        label: 'Fees & <Credits>',
        status: 'Obsolete',
        assignments: [
          { name: 'Set_A', assignmentItems: [{ assignToReference: 'x', operator: 'Assign' }] },
          { name: 'Set_B' },
        ],
        start: { locationX: 50, connector: { targetReference: 'Set_A' } },
        areMetricsLoggedToDataCloud: false,
      },
      { b: '2', a: '1', list: [{ z: 'x', y: 'w' }] },
      {
        label: 'Order Router v12',
        description: 'd'.repeat(2500),
        assignments: [{ name: 'Set_Flag' }],
        start: { connector: { targetReference: 'Set_Flag' } },
      },
      // Nulls, empty objects and empty lists, as the Tooling API returns them.
      { label: 'Sparse', description: null, variables: [], start: {}, processMetadataValues: [{}] },
      {},
    ];
    for (const metadata of conversions) {
      const xml = flowMetadataJsonToXml(metadata);
      expect(checkFlowXml(xml), xml.slice(0, 120)).toEqual({ ok: true });
    }
  });
});

describe('stripBom', () => {
  it('drops exactly one leading U+FEFF and nothing else', () => {
    expect(stripBom(`${BOM}<Flow/>`)).toBe('<Flow/>');
    expect(stripBom(`${BOM}${BOM}<Flow/>`)).toBe(`${BOM}<Flow/>`);
    expect(stripBom('<Flow/>')).toBe('<Flow/>');
    expect(stripBom(`<Flow>${BOM}</Flow>`)).toBe(`<Flow>${BOM}</Flow>`);
    expect(stripBom(` ${BOM}<Flow/>`)).toBe(` ${BOM}<Flow/>`);
    expect(stripBom('  \n<Flow/>\n')).toBe('  \n<Flow/>\n');
    expect(stripBom(BOM)).toBe('');
    expect(stripBom('')).toBe('');
  });
});

describe('countFlowElements', () => {
  it('counts the Start node plus every element the page draws', () => {
    // SEND_INVOICE_FLOW_XML: one recordLookups, one actionCalls, one subflows.
    expect(countFlowElements(SEND_INVOICE_FLOW_XML)).toBe(4);
  });

  it('counts repeats and ignores tags the page does not draw as nodes', () => {
    const xml =
      '<Flow><label>x</label>' +
      '<decisions><name>D1</name></decisions><decisions><name>D2</name></decisions><decisions><name>D3</name></decisions>' +
      '<variables><name>v</name></variables><formulas><name>f</name></formulas>' +
      '<screens><name>S</name></screens><start><connector><targetReference>D1</targetReference></connector></start>' +
      '</Flow>';
    expect(countFlowElements(xml)).toBe(5);
  });

  it('counts one element of every drawn kind', () => {
    const xml = `<Flow>${FLOW_NODE_TAGS.map((tag, i) => `<${tag}><name>N${i}</name></${tag}>`).join('')}</Flow>`;
    expect(countFlowElements(xml)).toBe(1 + FLOW_NODE_TAGS.length);
  });

  it('an empty flow is the Start node alone', () => {
    expect(countFlowElements('<Flow/>')).toBe(1);
    expect(countFlowElements('<Flow xmlns="http://soap.sforce.com/2006/04/metadata"></Flow>')).toBe(1);
  });

  it('is null on garbage: the parsed object has no Flow key', () => {
    expect(countFlowElements('just some words')).toBeNull();
    expect(countFlowElements('')).toBeNull();
    expect(countFlowElements('<CustomObject><label>x</label></CustomObject>')).toBeNull();
  });

  it('is null when the parser throws', () => {
    // fast-xml-parser throws on an unclosed comment or CDATA section.
    expect(countFlowElements('<Flow><!-- never closed')).toBeNull();
    expect(countFlowElements('<Flow><![CDATA[ never closed')).toBeNull();
  });
});
