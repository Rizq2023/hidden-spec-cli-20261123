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
  /** Moves a move edit recorded, in order: used to print `R` lines (SPEC.md section 2). */
  readonly moves: Array<{ from: string; to: string }> = [];
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

// ---------------------------------------------------------------- section 5: matching lines

/** A line of N: `ctx` is its index in O when it is a context line, else null. */
interface NewLine {
  text: string;
  ctx: number | null;
}

const trimSpaces = (s: string): string => s.replace(/^ +/, '').replace(/ +$/, '');
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** A file's lines, its line break, and whether it ends with one (SPEC.md section 3). */
function splitFile(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** Positions at or after `from` where O occurs in `lines` at the given tier. An empty O never matches: insertions are handled by the callers, not by matching. */
function occurrencesAt(O: string[], lines: string[], tier: number, from: number): number[] {
  if (O.length === 0) return [];
  const norm = tier === 0 ? (s: string): string => s : tier === 1 ? stripTrail : stripBoth;
  const want = O.map(norm);
  const out: number[] = [];
  for (let i = Math.max(0, from); i + O.length <= lines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < O.length; k += 1) {
      if (norm(lines[i + k]!) !== want[k]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from` (tier 0 only when strict), with its positions. */
function findTier(
  O: string[],
  lines: string[],
  strict: boolean,
  from: number,
  ok?: (pos: number) => boolean,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let pos = occurrencesAt(O, lines, t, from);
    if (ok !== undefined) pos = pos.filter(ok);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** Replace lines[at .. at+O.length) with N: context lines take the file's own line, other lines re-indent at tier 2. */
function applyReplace(lines: string[], at: number, O: string[], N: NewLine[], tier: number): string[] {
  const out = lines.slice(0, at);
  const f = tier === 2 && O.length > 0 ? leadingWs(lines[at]!) : '';
  const p = tier === 2 && O.length > 0 ? leadingWs(O[0]!) : '';
  for (const n of N) {
    if (n.ctx !== null) out.push(lines[at + n.ctx]!);
    else if (tier === 2 && n.text !== '' && n.text.trim() !== '' && n.text.startsWith(p)) out.push(f + n.text.slice(p.length));
    else out.push(n.text);
  }
  out.push(...lines.slice(at + O.length));
  return out;
}

// ---------------------------------------------------------------- section 6: unified diffs

interface Hunk {
  a: number;
  o: string[];
  n: NewLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noBreak: boolean;
  /** A `\` line follows the hunk's last `+` line (for creations). */
  plusNoBreak: boolean;
  /** How many `+` lines the hunk has. */
  plusCount: number;
}

interface Section {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  gitOld: string | undefined;
  gitNew: string | undefined;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const gitRe = /^diff --git a\/(.*) b\/(.*)$/;
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;

  const diffPath = (raw: string): string | null => {
    let p = trimSpaces(raw.slice(4).split('\t')[0]!);
    if (p === '/dev/null') return null;
    if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
    return p;
  };

  const parseHunk = (at: number, m: RegExpExecArray): { h: Hunk; next: number } => {
    const body: Array<{ kind: 'ctx' | 'old' | 'new'; text: string; bs: boolean }> = [];
    let j = at + 1;
    while (j < lines.length) {
      const l = lines[j]!;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
      if (l.startsWith('@@')) break;
      if (l.startsWith('\\')) {
        if (body.length > 0) body[body.length - 1]!.bs = true;
        j += 1;
        continue;
      }
      if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
        body.push({ kind: l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : 'new', text: l.slice(1), bs: false });
        j += 1;
        continue;
      }
      if (l === '') {
        body.push({ kind: 'ctx', text: '', bs: false });
        j += 1;
        continue;
      }
      break;
    }
    while (body.length > 0) {
      const last = body[body.length - 1]!;
      if (last.kind === 'ctx' && last.text === '') body.pop();
      else break;
    }
    const o: string[] = [];
    const n: NewLine[] = [];
    let plusCount = 0;
    for (const b of body) {
      if (b.kind === 'ctx') {
        o.push(b.text);
        n.push({ text: b.text, ctx: o.length - 1 });
      } else if (b.kind === 'old') {
        o.push(b.text);
      } else {
        n.push({ text: b.text, ctx: null });
        plusCount += 1;
      }
    }
    let noBreak = false;
    for (let k = body.length - 1; k >= 0; k -= 1) {
      const b = body[k]!;
      if (b.kind === 'ctx' || b.kind === 'new') {
        noBreak = b.bs;
        break;
      }
    }
    let plusNoBreak = false;
    for (let k = body.length - 1; k >= 0; k -= 1) {
      const b = body[k]!;
      if (b.kind === 'new') {
        plusNoBreak = b.bs;
        break;
      }
    }
    return { h: { a: Number(m[1]), o, n, noBreak, plusNoBreak, plusCount }, next: j };
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = gitRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = {
        pairOld: undefined,
        pairNew: undefined,
        renameOld: undefined,
        renameNew: undefined,
        gitOld: m[1],
        gitNew: m[2],
        create: false,
        remove: false,
        hunks: [],
      };
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader) {
        cur.pairOld = diffPath(line);
        cur.pairNew = diffPath(lines[i + 1]!);
      } else {
        cur = {
          pairOld: diffPath(line),
          pairNew: diffPath(lines[i + 1]!),
          renameOld: undefined,
          renameNew: undefined,
          gitOld: undefined,
          gitNew: undefined,
          create: false,
          remove: false,
          hunks: [],
        };
        sections.push(cur);
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = hunkRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const { h, next } = parseHunk(i, m);
      cur.hunks.push(h);
      inHeader = false;
      i = next;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        cur.pairNew = diffPath(line);
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameOld = line.slice('rename from '.length);
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameNew = line.slice('rename to '.length);
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.create = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.remove = true;
        i += 1;
        continue;
      }
    }
    i += 1;
  }
  return sections.map((s) => sectionEdit(s, strict));
}

function sectionEdit(s: Section, strict: boolean): Edit {
  const oldP = s.pairOld !== undefined ? s.pairOld : s.renameOld !== undefined ? s.renameOld : s.gitOld ?? null;
  const newP = s.pairNew !== undefined ? s.pairNew : s.renameNew !== undefined ? s.renameNew : s.gitNew ?? null;
  const isCreate = oldP === null || s.create;
  const isDelete = !isCreate && (newP === null || s.remove);
  const isMove = !isCreate && !isDelete && oldP !== newP;
  return (tree: Tree) => {
    if (isCreate) {
      const p = newP;
      if (p === null || !safe(p)) throw new Fail('unsafe', p ?? '');
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const added: string[] = [];
      for (const h of s.hunks) for (const nl of h.n) if (nl.ctx === null) added.push(nl.text);
      let noBreak = false;
      for (let k = s.hunks.length - 1; k >= 0; k -= 1) {
        if (s.hunks[k]!.plusCount > 0) {
          noBreak = s.hunks[k]!.plusNoBreak;
          break;
        }
      }
      tree.now.set(p, joinFile(added, '\n', !noBreak));
      return;
    }
    if (isDelete) {
      const p = oldP;
      if (p === null || !safe(p)) throw new Fail('unsafe', p ?? '');
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const p = oldP;
    if (p === null || !safe(p)) throw new Fail('unsafe', p ?? '');
    let target = p;
    if (isMove) {
      const t = newP;
      if (t === null || !safe(t)) throw new Fail('unsafe', t ?? '');
      target = t;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (isMove && tree.get(target) !== null) throw new Fail('exists', target);
    let { lines, br, final } = splitFile(before);
    let d = 0;
    for (const h of s.hunks) {
      if (h.o.length === 0) {
        const pos = Math.min(Math.max(h.a + d, 0), lines.length);
        const ins = h.n.map((nl) => nl.text);
        const atEnd = pos === lines.length;
        lines = [...lines.slice(0, pos), ...ins, ...lines.slice(pos)];
        if (atEnd) final = !h.noBreak;
        d += h.n.length;
      } else {
        const found = findTier(h.o, lines, strict, 0);
        if (found === null) throw new Fail('no-match', p);
        const want = h.a - 1 + d;
        let best = found.positions[0]!;
        let bestDist = Math.abs(best - want);
        for (const pos of found.positions) {
          const dist = Math.abs(pos - want);
          if (dist < bestDist) {
            best = pos;
            bestDist = dist;
          }
        }
        const touchesEnd = best + h.o.length === lines.length;
        lines = applyReplace(lines, best, h.o, h.n, found.tier);
        if (touchesEnd) final = !h.noBreak;
        d += h.n.length - h.o.length;
      }
    }
    const out = joinFile(lines, br, final);
    if (isMove) {
      tree.now.set(target, out);
      tree.now.set(p, null);
      tree.moves.push({ from: p, to: target });
    } else {
      tree.now.set(p, out);
    }
  };
}

// ---------------------------------------------------------------- section 7: SEARCH/REPLACE blocks

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    let s = -1;
    for (let j = i; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let m = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        m = j;
        break;
      }
    }
    if (m < 0) throw new Exit2(`error: parse ${s + 1}`);
    let e = -1;
    for (let j = m + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        e = j;
        break;
      }
    }
    if (e < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let j = s - 1; j >= prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    prevPath = path;
    const old = lines.slice(s + 1, m);
    const next = lines.slice(m + 1, e);
    edits.push(srEdit(path, old, next, strict));
    prevEnd = e + 1;
    i = e + 1;
  }
  return edits;
}

function srEdit(path: string, old: string[], next: string[], strict: boolean): Edit {
  return (tree: Tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (old.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, joinFile(next, '\n', true));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const { lines, br, final } = splitFile(before);
    const found = findTier(old, lines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const n: NewLine[] = next.map((t) => ({ text: t, ctx: null }));
    const out = applyReplace(lines, found.positions[0]!, old, n, found.tier);
    tree.now.set(path, joinFile(out, br, final));
  };
}

// ---------------------------------------------------------------- section 8: V4A patches

interface V4AChunk {
  anchor: string | null;
  o: string[];
  n: NewLine[];
  eof: boolean;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const collectSection = (start: number): { body: string[]; startIdx: number; next: number } => {
    let e = last;
    for (let j = start; j < last; j += 1) {
      if (isSectionStart(lines[j]!)) {
        e = j;
        break;
      }
    }
    let bodyEnd = e;
    while (bodyEnd > start && blank(lines[bodyEnd - 1]!)) bodyEnd -= 1;
    return { body: lines.slice(start, bodyEnd), startIdx: start, next: e };
  };

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ')) {
      const path = trimSpaces(line.slice('*** Add File: '.length));
      const { body, startIdx, next } = collectSection(i + 1);
      const fileLines: string[] = [];
      for (let k = 0; k < body.length; k += 1) {
        const bl = body[k]!;
        if (bl.startsWith('+')) fileLines.push(bl.slice(1));
        else if (bl === '') fileLines.push('');
        else throw new Exit2(`error: parse ${startIdx + k + 1}`);
      }
      edits.push((tree: Tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, joinFile(fileLines, '\n', true));
      });
      i = next;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = trimSpaces(line.slice('*** Delete File: '.length));
      const { body, startIdx, next } = collectSection(i + 1);
      if (body.length > 0) throw new Exit2(`error: parse ${startIdx + 1}`);
      edits.push((tree: Tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      i = next;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = trimSpaces(line.slice('*** Update File: '.length));
      const { body, startIdx, next } = collectSection(i + 1);
      edits.push(updateEdit(path, body, startIdx, i + 1, strict));
      i = next;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function updateEdit(path: string, body: string[], startIdx: number, updateLineNo: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  let k = 0;
  if (body.length > 0 && body[0]!.startsWith('*** Move to: ')) {
    moveTo = trimSpaces(body[0]!.slice('*** Move to: '.length));
    k = 1;
  }
  const chunks: V4AChunk[] = [];
  let cur: { anchor: string | null; lines: Array<{ kind: 'ctx' | 'old' | 'new'; text: string }>; eof: boolean } | null = null;
  const flush = (): void => {
    if (cur === null) return;
    const o: string[] = [];
    const n: NewLine[] = [];
    for (const l of cur.lines) {
      if (l.kind === 'ctx') {
        o.push(l.text);
        n.push({ text: l.text, ctx: o.length - 1 });
      } else if (l.kind === 'old') {
        o.push(l.text);
      } else {
        n.push({ text: l.text, ctx: null });
      }
    }
    chunks.push({ anchor: cur.anchor, o, n, eof: cur.eof });
    cur = null;
  };
  let firstChunk = true;
  for (; k < body.length; k += 1) {
    const l = body[k]!;
    const lineNo = startIdx + k + 1;
    if (l.startsWith('@@')) {
      flush();
      const anchor = trimSpaces(l.slice(2));
      cur = { anchor: anchor === '' ? null : anchor, lines: [], eof: false };
      firstChunk = false;
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${lineNo}`);
      cur.eof = true;
      flush();
      firstChunk = false;
      continue;
    }
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
      if (cur === null) {
        if (!firstChunk) throw new Exit2(`error: parse ${lineNo}`);
        cur = { anchor: null, lines: [], eof: false };
      }
      cur.lines.push({ kind: l === '' ? 'ctx' : l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : 'new', text: l === '' ? '' : l.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${lineNo}`);
  }
  flush();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLineNo}`);
  return (tree: Tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let { lines, br, final } = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findTier([ch.anchor], lines, strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.positions[0]! + 1;
      }
      if (ch.o.length === 0) {
        const pos = ch.eof ? lines.length : cursor;
        const ins = ch.n.map((nl) => nl.text);
        lines = [...lines.slice(0, pos), ...ins, ...lines.slice(pos)];
        cursor = pos + ins.length;
      } else {
        const ok = ch.eof ? (pos: number): boolean => pos + ch.o.length === lines.length : undefined;
        const found = findTier(ch.o, lines, strict, cursor, ok);
        if (found === null) throw new Fail('no-match', path);
        const at = found.positions[0]!;
        lines = applyReplace(lines, at, ch.o, ch.n, found.tier);
        cursor = at + ch.n.length;
      }
    }
    const out = joinFile(lines, br, final);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push({ from: path, to: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
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
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rPairs = new Map<string, string>();
  const rNews = new Set<string>();
  for (const m of tree.moves) {
    const oldWas = tree.original(m.from);
    const oldNow = tree.now.get(m.from);
    const newWas = tree.original(m.to);
    const newNow = tree.now.get(m.to);
    if (oldWas !== null && oldNow === null && newWas === null && newNow !== undefined && newNow !== null) {
      rPairs.set(m.from, m.to);
      rNews.add(m.to);
    }
  }
  const rows: Array<{ key: string; line: string }> = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (rPairs.has(p)) rows.push({ key: rPairs.get(p)!, line: `R ${p} -> ${rPairs.get(p)}` });
    else if (!rNews.has(p)) rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  return { code: 0, out: [...outLines, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
