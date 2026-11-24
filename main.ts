// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves that succeeded, as [old, new] pairs, for the R output lines (section 2). */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- section 3: a file as lines, its break and its final break ----------
interface FileLines { lines: string[]; br: string; final: boolean; }

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

// ---------- section 5: matching lines at three tiers ----------
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Occurrences of O in file at or after `from`, at the first tier with at least one (tier 0 only when strict). */
function findOccFrom(O: string[], file: string[], from: number, strict: boolean): { tier: number; pos: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const pos: number[] = [];
    for (let i = from; i + O.length <= file.length; i++) {
      let ok = true;
      for (let j = 0; j < O.length; j++) {
        if (!lineEq(O[j]!, file[i + j]!, tier)) { ok = false; break; }
      }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

/** First line at or after `from` equal to `anchor`, at the first tier with one. */
function findSingle(anchor: string, file: string[], from: number, strict: boolean): { tier: number; pos: number } | null {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    for (let i = from; i < file.length; i++) {
      if (lineEq(anchor, file[i]!, tier)) return { tier, pos: i };
    }
  }
  return null;
}

type OutItem = { line: string } | { ctx: number };

/** The N lines to write for an occurrence at `at`, tier `tier`: context lines are the file's own matched lines,
 *  other lines are re-indented at tier 2 (section 5). */
function buildReplacement(file: string[], O: string[], out: OutItem[], at: number, tier: number): string[] {
  const F = leadWs(file[at] ?? '');
  const P = O.length > 0 ? leadWs(O[0]!) : '';
  return out.map((it) => {
    if ('ctx' in it) return file[at + it.ctx]!;
    const s = it.line;
    if (tier === 2 && s !== '' && !/^[ \t]+$/.test(s) && s.startsWith(P)) return F + s.slice(P.length);
    return s;
  });
}

interface BodyParts { O: string[]; out: OutItem[]; plus: string[]; lastCtxPlusNoEol: boolean; lastPlusNoEol: boolean; }

/** Body lines (' ' context, '-' old, '+' new, '\' marker, empty context) into O and N. */
function parseBody(body: string[]): BodyParts {
  const O: string[] = [];
  const out: OutItem[] = [];
  const plus: string[] = [];
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const l = body[k]!;
    if (l === '') { O.push(''); out.push({ ctx: O.length - 1 }); lastCtxPlus = k; }
    else if (l[0] === ' ') { const t = l.slice(1); O.push(t); out.push({ ctx: O.length - 1 }); lastCtxPlus = k; }
    else if (l[0] === '-') { O.push(l.slice(1)); }
    else if (l[0] === '+') { const t = l.slice(1); out.push({ line: t }); plus.push(t); lastPlus = k; lastCtxPlus = k; }
  }
  const follows = (idx: number): boolean => idx >= 0 && idx + 1 < body.length && body[idx + 1]![0] === '\\';
  return { O, out, plus, lastCtxPlusNoEol: follows(lastCtxPlus), lastPlusNoEol: follows(lastPlus) };
}

// ---------- section 6: unified diffs ----------
interface Hunk { a: number; parts: BodyParts; }

function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  let f = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const { O, out } = h.parts;
    if (O.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), f.lines.length);
      const built = out.map((it) => ('ctx' in it ? '' : it.line));
      const lines = [...f.lines.slice(0, at), ...built, ...f.lines.slice(at)];
      const final = at === f.lines.length ? !h.parts.lastCtxPlusNoEol : f.final;
      f = { lines, br: f.br, final };
      d += built.length;
    } else {
      const occ = findOccFrom(O, f.lines, 0, strict);
      if (occ === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let at = occ.pos[0]!;
      for (const p of occ.pos) {
        if (Math.abs(p - target) < Math.abs(at - target)) at = p;
      }
      const built = buildReplacement(f.lines, O, out, at, occ.tier);
      const lines = [...f.lines.slice(0, at), ...built, ...f.lines.slice(at + O.length)];
      const final = at + O.length === f.lines.length ? !h.parts.lastCtxPlusNoEol : f.final;
      f = { lines, br: f.br, final };
      d += out.length - O.length;
    }
  }
  return joinFile(f);
}

interface Section {
  pairOld?: string; pairNew?: string;
  renameFrom?: string; renameTo?: string;
  gitOld: string | null; gitNew: string | null;
  newFile: boolean; deletedFile: boolean;
  hunks: Hunk[];
}

function headerPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const n = i + 1;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${n}`);
      sec = { gitOld: m[1]!, gitNew: m[2]!, newFile: false, deletedFile: false, hunks: [] };
      sections.push(sec);
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (sec !== null && inHeader) {
        sec.pairOld = headerPath(line);
        sec.pairNew = headerPath(lines[i + 1]!);
      } else {
        sec = { gitOld: null, gitNew: null, newFile: false, deletedFile: false, hunks: [] };
        sec.pairOld = headerPath(line);
        sec.pairNew = headerPath(lines[i + 1]!);
        sections.push(sec);
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && inHeader) throw new Exit2(`error: parse ${n + 1}`);
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${n}`);
      if (sec === null) throw new Exit2(`error: parse ${n}`);
      let j = i + 1;
      const body: string[] = [];
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') { body.push(l); j++; }
        else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      sec.hunks.push({ a: parseInt(m[1]!, 10), parts: parseBody(body) });
      inHeader = false;
      i = j;
      continue;
    }
    if (inHeader && sec !== null) {
      if (line.startsWith('rename from ')) sec.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) sec.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) sec.newFile = true;
      else if (line.startsWith('deleted file mode')) sec.deletedFile = true;
    }
    i++;
  }
  return sections.map((s) => makeUnifiedEdit(s, strict));
}

function makeUnifiedEdit(sec: Section, strict: boolean): Edit {
  const oldPath = sec.pairOld !== undefined ? (sec.pairOld === '/dev/null' ? null : sec.pairOld) : (sec.renameFrom ?? sec.gitOld);
  const newPath = sec.pairNew !== undefined ? (sec.pairNew === '/dev/null' ? null : sec.pairNew) : (sec.renameTo ?? sec.gitNew);
  let kind: 'create' | 'delete' | 'move' | 'change';
  if (oldPath === null || sec.newFile) kind = 'create';
  else if (newPath === null || sec.deletedFile) kind = 'delete';
  else if (oldPath !== newPath) kind = 'move';
  else kind = 'change';
  return (tree) => {
    if (kind === 'create') {
      const p = newPath;
      if (p === null) return;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus = sec.hunks.flatMap((h) => h.parts.plus);
      let noEol = false;
      for (let k = sec.hunks.length - 1; k >= 0; k--) {
        if (sec.hunks[k]!.parts.plus.length > 0) { noEol = sec.hunks[k]!.parts.lastPlusNoEol; break; }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (kind === 'delete') {
      const p = oldPath;
      if (p === null) return;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (kind === 'move') {
      const o = oldPath!;
      const nw = newPath!;
      if (!safe(o)) throw new Fail('unsafe', o);
      if (!safe(nw)) throw new Fail('unsafe', nw);
      const text = tree.get(o);
      if (text === null) throw new Fail('missing', o);
      if (tree.get(nw) !== null) throw new Fail('exists', nw);
      const out = applyHunks(text, sec.hunks, strict, o);
      tree.now.set(o, null);
      tree.now.set(nw, out);
      tree.moves.push([o, nw]);
      return;
    }
    const p = oldPath!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(text, sec.hunks, strict, p));
  };
}

// ---------- section 7: SEARCH/REPLACE blocks ----------
function makeSREdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const f = splitFile(text);
    const occ = findOccFrom(oldLines, f.lines, 0, strict);
    if (occ === null) throw new Fail('no-match', path);
    if (occ.pos.length > 1) throw new Fail('ambiguous', path);
    const at = occ.pos[0]!;
    const out: OutItem[] = newLines.map((l) => ({ line: l }));
    const built = buildReplacement(f.lines, oldLines, out, at, occ.tier);
    const lines = [...f.lines.slice(0, at), ...built, ...f.lines.slice(at + oldLines.length)];
    tree.now.set(path, joinFile({ lines, br: f.br, final: f.final }));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i++; continue; }
    const searchLine = i;
    let path: string | null = null;
    for (let k = searchLine - 1; k > prevReplaceEnd; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let k = searchLine + 1; k < lines.length; k++) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') { eq = k; break; }
      if (t === '<<<<<<< SEARCH' || t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k++) {
      const t = lines[k]!.trimEnd();
      if (t === '>>>>>>> REPLACE') { rep = k; break; }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(makeSREdit(path, lines.slice(searchLine + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// ---------- section 8: V4A patches ----------
interface VChunk { anchor: string | null; body: string[]; eof: boolean; }

function isV4aSectionStart(l: string): boolean {
  return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
}

function makeV4aAdd(path: string, content: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, content.length === 0 ? '' : content.join('\n') + '\n');
  };
}

function makeV4aDelete(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function makeV4aUpdate(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let f = splitFile(text);
    let cursor = 0;
    for (const ch of chunks) {
      const { O, out } = parseBody(ch.body);
      if (ch.anchor !== null && ch.anchor !== '') {
        const found = findSingle(ch.anchor, f.lines, cursor, strict);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.pos + 1;
      }
      if (O.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        const built = out.map((it) => ('ctx' in it ? '' : it.line));
        f = { lines: [...f.lines.slice(0, at), ...built, ...f.lines.slice(at)], br: f.br, final: f.final };
        cursor = at + built.length;
      } else {
        const occ = findOccFrom(O, f.lines, cursor, strict);
        if (occ === null) throw new Fail('no-match', path);
        let at: number | null = null;
        if (ch.eof) {
          for (const p of occ.pos) { if (p + O.length === f.lines.length) { at = p; break; } }
          if (at === null) throw new Fail('no-match', path);
        } else {
          at = occ.pos[0]!;
        }
        const built = buildReplacement(f.lines, O, out, at, occ.tier);
        f = { lines: [...f.lines.slice(0, at), ...built, ...f.lines.slice(at + O.length)], br: f.br, final: f.final };
        cursor = at + out.length;
      }
    }
    const outText = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, outText);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, outText);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) { last = k; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) { i++; continue; }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      let j = i + 1;
      while (j < last && !isV4aSectionStart(lines[j]!)) j++;
      const raw = lines.slice(i + 1, j);
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      const content: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k]!;
        if (l.startsWith('+')) content.push(l.slice(1));
        else if (blank(l)) content.push('');
        else throw new Exit2(`error: parse ${i + k + 2}`);
      }
      edits.push(makeV4aAdd(path, content));
      i = j;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      let j = i + 1;
      while (j < last && !isV4aSectionStart(lines[j]!)) {
        if (!blank(lines[j]!)) throw new Exit2(`error: parse ${j + 1}`);
        j++;
      }
      edits.push(makeV4aDelete(path));
      i = j;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      let j = i + 1;
      while (j < last && !isV4aSectionStart(lines[j]!)) j++;
      const raw = lines.slice(i + 1, j);
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      let moveTo: string | null = null;
      let k = 0;
      if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.slice('*** Move to: '.length).trim();
        k = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (; k < raw.length; k++) {
        const l = raw[k]!;
        if (l.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          cur = { anchor: l.slice(2).trim(), body: [], eof: false };
        } else if (l.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + k + 2}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) cur = { anchor: null, body: [], eof: false };
          cur.body.push(l);
        } else {
          throw new Exit2(`error: parse ${i + k + 2}`);
        }
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(makeV4aUpdate(path, moveTo, chunks, strict));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  const plain = new Map<string, string>();
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    plain.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  for (const [oldP, newP] of tree.moves) {
    const d = plain.get(oldP);
    const a = plain.get(newP);
    if (d !== undefined && d.startsWith('D ') && a !== undefined && a.startsWith('A ')) {
      plain.delete(oldP);
      plain.delete(newP);
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
    }
  }
  for (const [p, text] of plain) rows.push({ key: p, text });
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  const out = rows.map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
