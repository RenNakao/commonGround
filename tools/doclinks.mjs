#!/usr/bin/env node
// =================================================================================================
// DOCLINKS — the link database between the docs and the code, and the checks that keep it honest.
//
// THE DATABASE is `docs/links.json`, committed. Two halves:
//   curated — edited by hand: the doc-name registry ("SPEC-<topic>" -> its path), which docs are LIVE,
//             which code each doc COVERS (so changing the code names the doc to review), and files
//             that are RETIRED (deleted on purpose, so a live doc may still name them).
//   derived — rebuilt by `build` from the tree, never edited: every citation in both directions,
//             and a fingerprint of the line under every anchor a doc points at.
//
// THE CITATION FORMS it understands (and CLAUDE.md asks everyone to write):
//   in a doc, naming code:   `file.ts`                  the file (.ts .tsx .js .jsx .mjs .css .sh .py .jsonc)
//                            `file.ts@name`             a `// @anchor name` marker, or a declaration
//                            `file.ts:120@abc1234`      line 120 AS IT WAS at commit abc1234 — a
//                                                       record, frozen, for docs that describe the past
//   in code, naming a doc:   `SPEC-<topic> §3`, `SPEC-<topic> §3.2`, `README`, `CLAUDE`
// A bare `file.mjs:120` in a LIVE doc is an error: it rots the first time a line is added above it.
//
// COMMANDS (from the repo root):
//   node tools/doclinks.mjs build              rewrite `derived`
//   node tools/doclinks.mjs check [--memory]   errors exit 1; warnings print. --memory also checks
//                                              the agent memory directory for dangling paths
//   node tools/doclinks.mjs reviewed <docs> --why "…"   record: checked at HEAD, no change needed
//   node tools/doclinks.mjs impacted [files]   what to review for these changes (default: the
//                                              working tree against HEAD)
//   node tools/doclinks.mjs hook-post          Claude Code PostToolUse hook (JSON on stdin)
//   node tools/doclinks.mjs hook-stop          Claude Code Stop hook (JSON on stdin)
//   node tools/doclinks.mjs precommit          git pre-commit hook (warns, never blocks)
// =================================================================================================
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, relative, basename, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DB_PATH = 'docs/links.json';
const CODE_EXT = /\.(tsx?|jsx?|mjs|css|sh|py|jsonc)$/;
// Generated declaration files (worker-configuration.d.ts is ~600 KB) are not authored code.
const isCode = f => CODE_EXT.test(f) && !f.endsWith('.d.ts') && !f.startsWith('tools/fixtures/');
// With two files of one basename, a bare name means the shallowest one.
const pickShallowest = c => c.length ? [...c].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))[0] : null;

// ---------------------------------------------------------------------------------------------------
// THE REPO VIEW. Everything below takes one of these, so a test can hand in a fixture instead of git.
// ---------------------------------------------------------------------------------------------------
export function gitRepo(root = ROOT) {
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  // Validate newly authored docs/code before staging, while keeping ignored captures and secrets
  // outside the repository view. Deleted tracked paths are absent from the current tree.
  const files = [...new Set(git('ls-files', '--cached', '--others', '--exclude-standard', '-z')
    .split('\0').filter(Boolean))].filter(f => existsSync(join(root, f)));
  const cache = new Map();
  return {
    root, files,
    read(f) { if (!cache.has(f)) { try { cache.set(f, readFileSync(join(root, f), 'utf8')); } catch { cache.set(f, null); } } return cache.get(f); },
    // A pinned citation is checked against the commit it names, never against today's file.
    linesAt(sha, f) {
      try { return git('show', `${sha}:${f}`).split('\n').length; } catch { return null; }
    },
    commitTime(sha) { try { return Number(git('show', '-s', '--format=%ct', sha).trim()) || 0; } catch { return 0; } },
    head() { return git('rev-parse', '--short=7', 'HEAD').trim(); },
    lastCommitTime(f) { try { return Number(git('log', '-1', '--format=%ct', '--', f).trim()) || 0; } catch { return 0; } },
    changed() {
      const out = git('status', '--porcelain', '--untracked-files=all', '-z').split('\0').filter(Boolean);
      const paths = [];
      for (let i = 0; i < out.length; i++) {
        const e = out[i]; const code = e.slice(0, 2); let p = e.slice(3);
        if (code[0] === 'R' || code[0] === 'C') i++;            // the rename's source rides the next entry
        paths.push(p);
      }
      return paths;
    },
    staged() { return git('diff', '--cached', '--name-only', '-z').split('\0').filter(Boolean); },
    // The lines of `f` that changed, in the NEW file's numbering — so a doc edit can be mapped to the
    // sections it touched. `cached` = the index against HEAD (a commit); else the working tree against HEAD.
    changedLines(f, { cached = false } = {}) {
      let out = ''; try { out = git('diff', '-U0', ...(cached ? ['--cached'] : ['HEAD']), '--', f); } catch { return null; }
      if (!out) return null;                                 // untracked or unchanged: no hunks to read
      const lines = [];
      for (const m of out.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
        const start = +m[1], n = m[2] == null ? 1 : +m[2];
        for (let i = 0; i < Math.max(n, 1); i++) lines.push(start + i);
      }
      return lines;
    },
  };
}

export function loadDb(repo) {
  const raw = repo.read(DB_PATH);
  if (!raw) throw new Error(`${DB_PATH} is missing — it is the curated half of the link database and cannot be regenerated.`);
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------------------------------
// SMALL PIECES
// ---------------------------------------------------------------------------------------------------
const globToRe = g => new RegExp('^' + g.split('**').map(s => s.split('*').map(t => t.replace(/[.+^${}()|[\]\\?]/g, '\\$&')).join('[^/]*')).join('.*') + '$');
export const matches = (glob, f) => globToRe(glob).test(f);
const fingerprint = s => createHash('sha256').update(String(s).trim()).digest('hex').slice(0, 12);
const isLive = (db, f) => (db.curated.live || []).some(p => p.endsWith('/') ? f.startsWith(p) : f === p);
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;
function nextCodeIndex(text, from) {
  let i = from;
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text.startsWith('//', i)) { const n = text.indexOf('\n', i + 2); i = n < 0 ? text.length : n + 1; continue; }
    if (text.startsWith('/*', i)) { const n = text.indexOf('*/', i + 2); i = n < 0 ? text.length : n + 2; continue; }
    return i;
  }
}

/** Resolve `name` in a code file: a `@anchor name` marker (the line after it is the anchored line),
 *  else exactly one declaration — function, class, const/let/var, or a method at the start of a line. */
export function resolveAnchor(text, name) {
  const L = text.split('\n');
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const marks = L.flatMap((l, i) => new RegExp(`(?://|#)\\s*@anchor\\s+${esc}\\s*$`).test(l) ? [i] : []);
  if (marks.length === 1) {
    let j = marks[0] + 1; while (j < L.length && !L[j].trim()) j++;
    return { ok: true, kind: 'marker', line: j + 1, text: L[j] ?? '' };
  }
  if (marks.length > 1) return { ok: false, why: `the marker @anchor ${name} appears ${marks.length} times` };
  const decl = new RegExp(`^\\s*(?:export\\s+)?(?:(?:async\\s+)?function\\*?\\s+${esc}\\b|class\\s+${esc}\\b|(?:const|let|var)\\s+${esc}\\s*(?::[^=]+)?=|(?:interface|type|enum)\\s+${esc}\\b|(?:static\\s+)?(?:async\\s+)?${esc}\\s*\\([^)]*\\)\\s*\\{)`);
  const hits = L.flatMap((l, i) => decl.test(l) ? [i] : []);
  if (hits.length === 1) return { ok: true, kind: 'declaration', line: hits[0] + 1, text: L[hits[0]] };
  return { ok: false, why: hits.length ? `${hits.length} declarations are named ${name}; add a // @anchor marker` : `no // @anchor ${name} and no declaration of that name` };
}

// ---------------------------------------------------------------------------------------------------
// SCANNERS
// ---------------------------------------------------------------------------------------------------
/** Citations in a doc that name code. */
export function scanDocForCode(text) {
  const out = [];
  const re = /(?<![\w/.-])((?:\.\.?\/)*(?:[\w-]+\/)*[\w.-]+\.(?:tsx?|jsx?|mjs|css|sh|py|jsonc)(?![\w]))(?:@([A-Za-z_][\w-]*)|:(\d+(?:[-,]\d+)*)(?:@([0-9a-f]{7,40}))?)?/g;
  for (const m of text.matchAll(re)) {
    const [, path, anchor, lines, sha] = m;
    // A generated artifact under out/ (gitignored) or a path outside the repo is not a citation of the tree.
    if (/(^|\/)out\//.test(path)) continue;
    out.push({ path, anchor: anchor || null, line: lines ? parseInt(lines, 10) : null, lineText: lines || null, sha: sha || null, at: lineOf(text, m.index) });
  }
  return out;
}

/** Markdown links in a doc (relative ones only). */
export function scanDocLinks(text) {
  return [...text.matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)].map(m => ({ target: m[1], at: lineOf(text, m.index) }))
    .filter(l => !/^[a-z]+:/i.test(l.target));
}

/** Citations in code that name a doc, with the section when the citation gives one. */
export function scanCodeForDocs(text, names, notDocs = new Set()) {
  const hits = [];
  const alt = [...names].sort((a, b) => b.length - a.length).map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  if (alt) {
    const re = new RegExp(`\\b(${alt})(?:\\.md)?\\b(?:\\s*(?:§\\s*([0-9]+(?:\\.[0-9]+[a-z]?)?[a-z]?|[IVXL]+)(?:\\s*([RST][0-9]+[a-z]?))?|junction\\s+([0-9]+)|(PART\\s+[0-9]+|[Ss]tage\\s+[0-9A-Z]+)))?`, 'g');
    for (const m of text.matchAll(re)) {
      const [, name, sec, sub, junction, part] = m;
      hits.push({ name, section: sec ? `§${sec}${sub ? ' ' + sub : ''}` : junction ? `junction ${junction}` : part || null });
    }
  }
  // §11 R5 / §12 S2 / §13 T7 are RULINGS' own numbering and unambiguous even without the name.
  if (names.has('RULINGS')) for (const m of text.matchAll(/(?<!RULINGS\s*)§\s*(1[123])\s*([RST][0-9]+[a-z]?)\b/g)) hits.push({ name: 'RULINGS', section: `§${m[1]} ${m[2]}`, bare: true });
  // A doc name that LOOKS like one of ours but is not registered is a dangling citation.
  const unknown = [...new Set([...text.matchAll(/\b(SPEC-[a-z0-9-]+|REVIEW-[0-9-]+)(?:\.md)?\b/g)].map(m => m[1].replace(/-+$/, '')))]
    .filter(n => !names.has(n) && !notDocs.has(n));
  return { hits, unknown };
}

/** The sections of a doc, as [startLine, key] in order — so a line number can be mapped to "§11 R5". */
export function sectionsOf(text) {
  const out = []; let major = null;
  text.split('\n').forEach((l, i) => {
    let m;
    if ((m = /^#{2,3}\s+(?:§\s*)?([0-9]+(?:\.[0-9]+[a-z]?)?[a-z]?)[.)]?\s/.exec(l))) { out.push([i + 1, `§${m[1]}`]); if (!m[1].includes('.')) major = m[1]; }
    else if ((m = /^#{2}\s+([IVXL]+)\.\s/.exec(l))) { out.push([i + 1, `§${m[1]}`]); major = null; }
    else if (major && (m = /^\*\*([RST][0-9]+[a-z]?)\s+—/.exec(l))) out.push([i + 1, `§${major} ${m[1]}`]);
  });
  return out;
}
export const sectionAt = (text, line) => { let s = null; for (const [at, k] of sectionsOf(text)) { if (at <= line) s = k; else break; } return s; };

/** A deliberately small symbol map for impact reports. It recognizes declarations whose bodies are
 *  brace-delimited (functions, classes, methods, and const/let/var initializers). It is not a JS
 *  parser: comments and quoted strings are skipped while pairing braces, and the nearest/smallest
 *  recognized declaration containing an edited line supplies the symbol. */
function symbolRegions(text) {
  const pairs = new Map(), parens = new Map(), stack = [];
  let quote = null, lineComment = false, blockComment = false, escaped = false;
  const regexCanStart = at => {
    let p = at - 1; while (p >= 0 && /\s/.test(text[p])) p--;
    if (text.slice(Math.max(0, at - 2), at) === '=>') return true;
    if (p < 0 || '=(:,[!&|?{};'.includes(text[p])) return true;
    const word = text.slice(0, p + 1).match(/([\w$]+)$/)?.[1];
    return ['return', 'case', 'throw', 'typeof', 'void', 'delete', 'await', 'yield', 'in', 'of'].includes(word);
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && n === '/') { blockComment = false; i++; } continue; }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && n === '/') { lineComment = true; i++; continue; }
    if (c === '/' && n === '*') { blockComment = true; i++; continue; }
    if (c === '/' && regexCanStart(i)) {
      let inClass = false, slashEscaped = false;
      for (i++; i < text.length; i++) {
        const r = text[i];
        if (slashEscaped) { slashEscaped = false; continue; }
        if (r === '\\') { slashEscaped = true; continue; }
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) break;
      }
      while (i + 1 < text.length && /[a-z]/i.test(text[i + 1])) i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if ('({['.includes(c)) stack.push([c, i]);
    else if (')}]'.includes(c) && stack.length) {
      const [open, at] = stack[stack.length - 1];
      if ((open === '(' && c === ')') || (open === '{' && c === '}') || (open === '[' && c === ']')) {
        stack.pop();
        if (open === '{') pairs.set(at, i);
        if (open === '(') parens.set(at, i);
      }
    }
  }
  const ranges = [];
  const decl = /^\s*(?:export\s+)?(?:default\s+)?(?:(?:async\s+)?function\*?\s+([\w$]+)\b|class\s+([\w$]+)\b|(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=|(?:static\s+)?(?:async\s+)?([\w$]+)\s*\()/;
  const reserved = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);
  const lines = text.split('\n'); let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = decl.exec(lines[i]);
    if (m) {
      const name = m[1] || m[2] || m[3] || m[4];
      const from = offset;
      const lineEnd = from + lines[i].length;
      let brace = -1;
      if (m[2]) brace = text.indexOf('{', from);                         // class body
      else if (m[1] || m[4]) {
        // Skip destructuring braces in parameters: the method/function body follows its closing ).
        const open = text.indexOf('(', from), close = parens.get(open) ?? -1;
        const body = close >= 0 ? nextCodeIndex(text, close + 1) : -1;
        if (body >= 0 && text[body] === '{') brace = body;
      } else {
        const eq = text.indexOf('=', from) + 1;
        let p = eq; while (p < text.length && /\s/.test(text[p])) p++;
        const init = text.slice(eq, lineEnd);
        const arrow = init.indexOf('=>'), fn = init.search(/\bfunction\b/);
        if (text[p] === '{' && p <= lineEnd) brace = p;                // object initializer
        else if (arrow >= 0) {
          const body = nextCodeIndex(text, eq + arrow + 2);
          if (text[body] === '{') brace = body;
        } else if (fn >= 0) {
          const open = text.indexOf('(', eq + fn + 8), close = parens.get(open);
          const body = close == null ? -1 : nextCodeIndex(text, close + 1);
          if (body >= 0 && text[body] === '{') brace = body;
        }
      }
      const endAt = brace >= 0 ? pairs.get(brace) : null;
      if (endAt != null && !reserved.has(name)) ranges.push({ name, start: i + 1, end: lineOf(text, endAt) });
    }
    offset += lines[i].length + 1;
  }
  return ranges;
}

function symbolsAt(text, lines) {
  const regions = symbolRegions(text), found = new Set();
  for (const line of lines) {
    const containing = regions.filter(r => r.start <= line && line <= r.end).sort((a, b) => (a.end - a.start) - (b.end - b.start));
    if (containing[0]) found.add(containing[0].name);
  }
  return found;
}

function symbolAtAnchor(text, name) {
  const anchor = resolveAnchor(text, name);
  return anchor.ok ? symbolsAt(text, [anchor.line]).values().next().value || null : null;
}

function editedLines(text, snippets) {
  const out = new Set();
  for (const snippet of snippets.filter(s => typeof s === 'string' && s.trim())) {
    let from = 0, at;
    while ((at = text.indexOf(snippet, from)) >= 0) {
      const first = lineOf(text, at), count = snippet.split('\n').length;
      for (let i = 0; i < count; i++) out.add(first + i);
      from = at + Math.max(snippet.length, 1);
    }
  }
  return [...out];
}

function sentencesMentioning(text, symbols) {
  const out = [];
  // Join wrapped prose within paragraphs, while keeping table cells separate. This returns the
  // smallest useful excerpt without treating an entire paragraph as impact evidence.
  const blocks = text.split(/\n\s*\n/).filter(block => !block.includes('```'));
  for (const block of blocks) for (const cell of block.split('|')) {
    for (const part of cell.replace(/\n/g, ' ').split(/(?<=[.!?])\s+/)) {
      const sentence = part.trim().replace(/^[-*+\s]+/, '').replace(/\s+/g, ' ');
      if (sentence && [...symbols].some(s => identifierOccurs(sentence, s))) out.push(sentence);
    }
  }
  return [...new Set(out)];
}

const commonWordSymbols = new Set(['add', 'anchor', 'build', 'check', 'class', 'code', 'create', 'doc', 'edit', 'file', 'first', 'from', 'function', 'get', 'link', 'lines', 'name', 'new', 'open', 'path', 'read', 'return', 'run', 'section', 'text', 'to', 'update', 'write']);
const identifierOccurs = (text, name) => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Common English words make weak prose matches unless the doc marks them as code or calls them.
  if (commonWordSymbols.has(name)) return new RegExp('(?:`' + escaped + '`|@' + escaped + '\\b|' + escaped + '\\s*\\()').test(text);
  return new RegExp(`(^|[^\\w$])${escaped}(?![\\w$])`).test(text);
};

// ---------------------------------------------------------------------------------------------------
// BUILD — the derived half
// ---------------------------------------------------------------------------------------------------
export function build(repo, db) {
  const names = new Set(Object.keys(db.curated.docs));
  const codeFiles = repo.files.filter(isCode);
  const docFiles = repo.files.filter(f => f.endsWith('.md'));
  const byBase = new Map();
  for (const f of repo.files) { const b = basename(f); byBase.set(b, [...(byBase.get(b) || []), f]); }
  const resolvePath = (from, p) => {
    if (p.includes('/')) { const c = posix.normalize(posix.join(posix.dirname(from), p)); if (repo.files.includes(c)) return c; if (repo.files.includes(p)) return p; }
    const c = byBase.get(basename(p)) || [];
    return pickShallowest(c);
  };

  const cites = {};      // code file -> { docName: [sections] }
  for (const f of codeFiles) {
    const { hits } = scanCodeForDocs(repo.read(f) || '', names);
    if (!hits.length) continue;
    const m = {};
    for (const h of hits) { m[h.name] = m[h.name] || new Set(); if (h.section) m[h.name].add(h.section); }
    cites[f] = Object.fromEntries(Object.entries(m).sort().map(([k, v]) => [k, [...v].sort()]));
  }
  const refs = {};       // doc -> [ "path", "path@anchor", "path:N@sha" ]
  const anchors = {};    // "path@anchor" -> fingerprint of the anchored line
  for (const d of docFiles) {
    const set = new Set();
    for (const c of scanDocForCode(repo.read(d) || '')) {
      const p = resolvePath(d, c.path) || c.path;
      if (c.anchor) {
        const key = `${p}@${c.anchor}`; set.add(key);
        const t = repo.read(p);
        if (t != null) { const r = resolveAnchor(t, c.anchor); if (r.ok) anchors[key] = fingerprint(r.text); }
      } else if (c.sha) set.add(`${p}:${c.lineText}@${c.sha}`);
      else set.add(p);
    }
    for (const l of scanDocLinks(repo.read(d) || '')) {
      const t = posix.normalize(posix.join(posix.dirname(d), l.target));
      if (repo.files.includes(t) && t.endsWith('.md')) set.add(t);
    }
    if (set.size) refs[d] = [...set].sort();
  }
  return {
    note: 'REBUILT by `node tools/doclinks.mjs build` — do not edit by hand.',
    codeCitesDocs: Object.fromEntries(Object.entries(cites).sort()),
    docCitesCode: Object.fromEntries(Object.entries(refs).sort()),
    anchors: Object.fromEntries(Object.entries(anchors).sort()),
  };
}

// ---------------------------------------------------------------------------------------------------
// CHECK — errors break the gate, warnings are printed
// ---------------------------------------------------------------------------------------------------
export function check(repo, db, { memoryDir = null } = {}) {
  const errors = [], warnings = [];
  const E = (where, msg) => errors.push(`${where}: ${msg}`);
  const W = (where, msg) => warnings.push(`${where}: ${msg}`);
  const names = new Set(Object.keys(db.curated.docs));
  const retired = db.curated.retired || {};
  const isRetired = p => Object.keys(retired).some(r => r === p || matches(r, p) || matches(r, p.replace(/^(\.\.\/)+/, '')) || (!r.includes('*') && basename(r) === basename(p)));
  const fileSet = new Set(repo.files);
  const baseSet = new Set(repo.files.map(f => basename(f)));

  for (const [n, p] of Object.entries(db.curated.docs)) if (!fileSet.has(p)) E(DB_PATH, `the registry maps "${n}" to ${p}, which does not exist`);
  for (const [doc, globs] of Object.entries(db.curated.covers || {})) {
    if (!fileSet.has(doc)) E(DB_PATH, `covers names a doc that does not exist: ${doc}`);
    for (const g of globs) if (!repo.files.some(f => matches(g, f))) E(DB_PATH, `${doc} covers "${g}", which matches no file`);
  }
  for (const r of Object.keys(retired)) if (!r.includes('*') && fileSet.has(r)) W(DB_PATH, `${r} is listed as retired but exists again`);

  const derived = db.derived || {};
  for (const d of repo.files.filter(f => f.endsWith('.md') && isLive(db, f))) {
    const text = repo.read(d) || '';
    for (const c of scanDocForCode(text)) {
      const where = `${d}:${c.at}`;
      const known = c.path.includes('/') ? (fileSet.has(posix.normalize(posix.join(posix.dirname(d), c.path))) || fileSet.has(c.path) || baseSet.has(basename(c.path))) : baseSet.has(basename(c.path));
      if (c.sha) {
        const full = [...fileSet].find(f => basename(f) === basename(c.path)) || c.path;
        const n = repo.linesAt(c.sha, full) ?? repo.linesAt(c.sha, c.path);
        if (n == null) E(where, `\`${c.path}:${c.lineText}@${c.sha}\` — that file does not exist at ${c.sha}`);
        else if (c.line > n) E(where, `\`${c.path}:${c.lineText}@${c.sha}\` — the file had only ${n} lines at ${c.sha}`);
        continue;
      }
      if (!known) { if (!isRetired(c.path)) E(where, `cites ${c.path}, which does not exist (fix the citation, or add it to curated.retired with why)`); continue; }
      if (c.line != null) { E(where, `\`${c.path}:${c.lineText}\` is a bare line citation in a live doc — use \`${basename(c.path)}@<anchor>\`, or pin it to a commit as \`${basename(c.path)}:${c.lineText}@<sha>\` if it describes the past`); continue; }
      if (c.anchor) {
        // The same preference `build`'s resolvePath has: with two files of one basename, the shallowest.
        const cands = [...fileSet].filter(f => basename(f) === basename(c.path) && (!c.path.includes('/') || f.endsWith(c.path)));
        const p = pickShallowest(cands);
        const r = resolveAnchor(repo.read(p) || '', c.anchor);
        if (!r.ok) { E(where, `\`${c.path}@${c.anchor}\` does not resolve: ${r.why}`); continue; }
        const key = `${p}@${c.anchor}`, was = derived.anchors?.[key];
        if (was && was !== fingerprint(r.text)) W(where, `the code under \`${c.path}@${c.anchor}\` changed since the last build — check the doc still says what the code does, then \`build\``);
      }
    }
    for (const l of scanDocLinks(text)) {
      const t = posix.normalize(posix.join(posix.dirname(d), l.target));
      if (!existsSync(join(repo.root, t)) && !fileSet.has(t)) E(`${d}:${l.at}`, `link to ${l.target} is broken`);
    }
  }
  for (const f of repo.files.filter(isCode)) {
    const { unknown } = scanCodeForDocs(repo.read(f) || '', names, new Set(db.curated.notDocs || []));
    for (const u of unknown) if (!isRetired(`${u}.md`)) E(f, `cites ${u}, which is not a registered doc (register it in curated.docs, or correct the name)`);
  }
  // The derived half must be what the tree says it is.
  const fresh = build(repo, db);
  for (const k of ['codeCitesDocs', 'docCitesCode']) if (JSON.stringify(fresh[k]) !== JSON.stringify(derived[k])) { W(DB_PATH, `derived.${k} is stale — run \`node tools/doclinks.mjs build\``); }
  const newAnchors = Object.keys(fresh.anchors).filter(k => !(k in (derived.anchors || {})));
  if (newAnchors.length) W(DB_PATH, `${newAnchors.length} anchor(s) not fingerprinted yet — run build`);

  // A doc older than the code it covers is the drift the whole database exists to surface.
  for (const [doc, globs] of Object.entries(db.curated.covers || {})) {
    // A doc is current as of its own last commit OR its last recorded review (`reviewed`), whichever is later:
    // "I checked it against the code and nothing needed to change" is an answer, and it is recorded, not assumed.
    const rv = db.curated.reviewed?.[doc];
    const td = Math.max(repo.lastCommitTime(doc), rv?.at && repo.commitTime ? repo.commitTime(rv.at) : 0); if (!td) continue;
    const newer = repo.files.filter(f => globs.some(g => matches(g, f)) && repo.lastCommitTime(f) > td);
    if (newer.length) W(doc, `older than ${newer.length} file(s) it covers (${newer.slice(0, 3).join(', ')}${newer.length > 3 ? ', …' : ''}) — review it`);
  }
  if (memoryDir) for (const w of checkMemory(repo, memoryDir)) W('memory', w);
  return { errors, warnings, stats: { liveDocs: repo.files.filter(f => f.endsWith('.md') && isLive(db, f)).length, codeFilesCiting: Object.keys(fresh.codeCitesDocs).length, docsCiting: Object.keys(fresh.docCitesCode).length, anchors: Object.keys(fresh.anchors).length } };
}

/** The agent memory directory lives outside the repo; its path-like mentions are checked against the tree. */
export function checkMemory(repo, dir) {
  const out = []; if (!existsSync(dir)) return [`no memory directory at ${dir}`];
  const baseSet = new Set(repo.files.map(f => basename(f)));
  for (const f of readdirSync(dir).filter(f => f.endsWith('.md'))) {
    const t = readFileSync(join(dir, f), 'utf8');
    for (const m of t.matchAll(/`((?:[\w.-]+\/)*[\w.-]+\.(?:mjs|md|sh|json))`/g)) {
      const p = m[1];
      if (p.startsWith('~') || p.includes('out/') || f === 'MEMORY.md') continue;
      if (!repo.files.includes(p) && !baseSet.has(basename(p))) out.push(`${f} mentions ${p}, which is not in the tree`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// IMPACT — what to review when these files change
// ---------------------------------------------------------------------------------------------------
export function impacted(repo, db, changed, { editText = null, changedLines = null, editSnippets = [] } = {}) {
  const derived = db.derived || build(repo, db);
  const out = new Map();   // target -> Set(reasons)
  const impactSymbols = new Map();
  const add = (t, why, symbols = null) => {
    if (changed.includes(t)) return;
    if (!out.has(t)) out.set(t, new Set());
    out.get(t).add(why);
    if (symbols?.size && t.endsWith('.md')) {
      if (!impactSymbols.has(t)) impactSymbols.set(t, new Set());
      for (const s of symbols) impactSymbols.get(t).add(s);
    }
  };
  const docPath = n => db.curated.docs[n];
  for (const f of changed) {
    if (f.endsWith('.md')) {
      const name = Object.entries(db.curated.docs).find(([, p]) => p === f)?.[0];
      for (const g of db.curated.covers?.[f] || []) for (const c of repo.files.filter(x => matches(g, x))) add(c, `covered by ${f}`);
      if (name) {
        // WHICH SECTIONS CHANGED. From the edit's own text (a hook) or from the diff's hunks (a commit,
        // a turn). With neither, nothing is listed: "every file that cites RULINGS" is a hundred files,
        // and a reminder that long is a reminder nobody reads.
        const t = repo.read(f) || '';
        const secs = new Set();
        if (editText) { for (const ln of editText.split('\n').map(l => l.trim()).filter(l => l.length > 12)) { const i = t.indexOf(ln); if (i >= 0) { const s = sectionAt(t, lineOf(t, i)); if (s) secs.add(s); } } }
        else if (changedLines) for (const ln of changedLines(f) || []) { const s = sectionAt(t, ln); if (s) secs.add(s); }
        const hitSec = cited => [...secs].filter(s => cited.some(c => c === s || c.startsWith(s + ' ') || s.startsWith(c + ' ')));
        if (secs.size) for (const [code, m] of Object.entries(derived.codeCitesDocs)) {
          const h = m[name] ? hitSec(m[name]) : [];
          if (h.length) add(code, `cites ${name} ${h.join(', ')}`);
        }
      }
      // (a doc that merely LINKS to this one is not asked to change with it — links are navigation, not claims)
      continue;
    }
    const sourceText = repo.read(f) || '';
    const lines = changedLines ? changedLines(f) || [] : editedLines(sourceText, editSnippets.length ? editSnippets : (editText ? [editText] : []));
    const fileSymbols = symbolsAt(sourceText, lines);
    for (const [doc, globs] of Object.entries(db.curated.covers || {})) if (globs.some(g => matches(g, f))) add(doc, `covers ${f}`, fileSymbols);
    // A doc that points at an ANCHOR in this file is asked to review — but when we know what the edit
    // touched, only if it touched the anchored line. A doc that merely NAMES the file is not: records
    // name files constantly, and a reminder on every edit is a reminder nobody reads.
    const text = sourceText;
    for (const [doc, rs] of Object.entries(derived.docCitesCode)) {
      if (!isLive(db, doc)) continue;
      const hit = rs.filter(r => r.startsWith(f + '@')).filter(r => {
        if (!editText) return true;
        const anchorName = r.slice(f.length + 1);
        const a = resolveAnchor(text, anchorName);
        const owningSymbol = symbolAtAnchor(text, anchorName);
        return !a.ok || (a.text.trim() && editText.includes(a.text.trim().slice(0, 60))) || editText.includes(`@anchor ${anchorName}`) || (owningSymbol && fileSymbols.has(owningSymbol));
      });
      if (hit.length) add(doc, `cites ${hit.map(h => h.slice(h.indexOf('@'))).join(', ')}`, fileSymbols);
    }
    if (editText) {
      const { hits } = scanCodeForDocs(editText, new Set(Object.keys(db.curated.docs)));
      for (const h of hits) if (docPath(h.name)) add(docPath(h.name), `the edited code cites ${h.name}${h.section ? ' ' + h.section : ''}`, fileSymbols);
    }
  }
  for (const [target, reasons] of out) {
    if (!target.endsWith('.md')) continue;
    const symbols = impactSymbols.get(target) || new Set();
    for (const sentence of sentencesMentioning(repo.read(target) || '', symbols)) reasons.add(`mentions ${[...symbols].filter(s => identifierOccurs(sentence, s)).join(', ')}: ${sentence}`);
  }
  return [...out].map(([target, why]) => ({ target, why: [...why] })).sort((a, b) => a.target.localeCompare(b.target));
}

const fmt = list => list.map(i => `  - ${i.target} — ${i.why.join('; ')}`).join('\n');
export const memoryDirFor = root => join(homedir(), '.claude', 'projects', root.replace(/[/.]/g, '-'), 'memory');

// ---------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------
async function stdinJson() { let s = ''; for await (const c of process.stdin) s += c; try { return JSON.parse(s || '{}'); } catch { return {}; } }

async function main() {
  const [cmd = 'check', ...args] = process.argv.slice(2);
  const repo = gitRepo(); const db = loadDb(repo);
  if (cmd === 'build') {
    db.derived = build(repo, db);
    writeFileSync(join(ROOT, DB_PATH), JSON.stringify(db, null, 2) + '\n');
    const d = db.derived; console.log(`built ${DB_PATH}: ${Object.keys(d.codeCitesDocs).length} code files cite docs, ${Object.keys(d.docCitesCode).length} docs cite code, ${Object.keys(d.anchors).length} anchors`);
    return;
  }
  if (cmd === 'check') {
    const r = check(repo, db, { memoryDir: args.includes('--memory') ? memoryDirFor(ROOT) : null });
    for (const w of r.warnings) console.log(`WARN  ${w}`);
    for (const e of r.errors) console.log(`ERROR ${e}`);
    console.log(`doclinks: ${r.errors.length} error(s), ${r.warnings.length} warning(s) — ${JSON.stringify(r.stats)}`);
    process.exit(r.errors.length ? 1 : 0);
  }
  if (cmd === 'reviewed') {
    // Record that these docs were checked against the code at HEAD and needed no change — with why.
    const why = args.includes('--why') ? args[args.indexOf('--why') + 1] : null;
    const docs = args.filter((a, i) => a !== '--why' && args[i - 1] !== '--why');
    if (!docs.length || !why) { console.error('usage: doclinks reviewed <doc...> --why "<what you checked and why no change was needed>"'); process.exit(2); }
    db.curated.reviewed = db.curated.reviewed || {};
    for (const d of docs) { if (!repo.files.includes(d)) { console.error(`no such doc: ${d}`); process.exit(2); } db.curated.reviewed[d] = { at: repo.head(), why }; }
    db.curated.reviewed = Object.fromEntries(Object.entries(db.curated.reviewed).sort());
    writeFileSync(join(ROOT, DB_PATH), JSON.stringify(db, null, 2) + '\n');
    console.log(`recorded review of ${docs.length} doc(s) at ${repo.head()}`);
    return;
  }
  if (cmd === 'impacted') {
    const files = args.length ? args : repo.changed();
    const list = impacted(repo, db, files, { changedLines: f => repo.changedLines(f) });
    console.log(list.length ? `For ${files.length} changed file(s), review:\n${fmt(list)}` : `Nothing linked to ${files.length} changed file(s).`);
    return;
  }
  if (cmd === 'hook-post') {
    const inp = await stdinJson();
    const abs = inp?.tool_input?.file_path; if (!abs) return;
    const f = relative(ROOT, abs); if (f.startsWith('..') || f === DB_PATH) return;
    const editSnippets = [inp.tool_input.new_string, inp.tool_input.content, ...(inp.tool_input.edits || []).map(e => e.new_string)].filter(Boolean);
    const editText = [inp.tool_input.old_string, inp.tool_input.new_string, inp.tool_input.content, ...(inp.tool_input.edits || []).flatMap(e => [e.old_string, e.new_string])].filter(Boolean).join('\n') || null;
    const list = impacted(repo, db, [f], { editText, editSnippets });
    if (!list.length) return;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse',
      additionalContext: `doclinks: ${f} is linked to the following. If this edit changed behaviour they describe (or a rule they state), update them in this task; if not, carry on.\n${fmt(list)}` } }));
    return;
  }
  if (cmd === 'hook-stop') {
    const inp = await stdinJson();
    if (inp.stop_hook_active) return;                       // remind once per stop, never loop
    const changed = repo.changed().filter(f => f !== DB_PATH);
    if (!changed.length) return;
    const list = impacted(repo, db, changed, { changedLines: f => repo.changedLines(f) }).filter(i => i.target.endsWith('.md') && isLive(db, i.target));
    const r = check(repo, db);
    const notes = [];
    if (list.length) notes.push(`These live docs are linked to files you changed and were not themselves changed:\n${fmt(list)}\nReview each; update it if the change affects what it says, otherwise say why not.`);
    if (r.errors.length) notes.push(`doclinks check has ${r.errors.length} error(s) (the gate will fail):\n${r.errors.slice(0, 8).map(e => '  - ' + e).join('\n')}`);
    if (r.warnings.some(w => w.includes('stale'))) notes.push('docs/links.json is stale — run `node tools/doclinks.mjs build` and include it in the commit.');
    if (notes.length) process.stdout.write(JSON.stringify({ decision: 'block', reason: notes.join('\n\n') }));
    return;
  }
  if (cmd === 'precommit') {
    const staged = repo.staged(); if (!staged.length) return;
    const list = impacted(repo, db, staged, { changedLines: f => repo.changedLines(f, { cached: true }) }).filter(i => isLive(db, i.target) || !i.target.endsWith('.md'));
    const r = check(repo, db);
    if (list.length) console.error(`doclinks — linked to what you are committing, and not in the commit:\n${fmt(list)}`);
    for (const e of r.errors) console.error(`doclinks ERROR ${e}`);
    if (r.warnings.some(w => w.includes('stale'))) console.error('doclinks — docs/links.json is stale: node tools/doclinks.mjs build');
    return;                                                  // warns, never blocks
  }
  console.error(`unknown command ${cmd}`); process.exit(2);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(e => { console.error(e.message); process.exit(1); });
