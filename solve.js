// solve.js — a fast, original implementation of the makefun-site 1.0.0 build.
//
// Written from the published rules (the kit's README) and the reference
// program's observable behaviour. run(input) returns exactly the output tree
// makefun-site 1.0.0 returns for the same input: a JSON object of every
// output path -> file text, byte for byte.
//
// The work is organised as one pass per source (front matter, Markdown,
// layout) with small per-case caches for pure string functions (slugify,
// long dates) and for template includes whose rendering depends only on
// values that do not change between renders. Nothing is cached from one
// case to the next: every per-case structure is built fresh inside run().

/* ------------------------------------------------------------------ text */

// Code-unit order (never the locale's).
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_REPLACE = /[&<>"']/g;

/** `text` with & < > " and ' escaped, and nothing else. */
function esc(text) {
  if (!ESC_TEST.test(text)) return text;
  return text.replace(ESC_REPLACE, (c) => ESCAPES[c]);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDateRaw(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

const MARK_RE = /\p{M}/gu;
const NON_ASCII_RE = /[^\x00-\x7F]/;
const NON_ALNUM_RUN_RE = /[^a-z0-9]+/g;
const EDGE_DASH_RE = /^-+|-+$/g;
const TRAIL_DASH_RE = /-+$/;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * 64 characters (a "-" left at the cut dropped), "untitled" when nothing is
 * left.
 */
function slugifyRaw(text) {
  if (!NON_ASCII_RE.test(text)) {
    // ASCII fast path: NFKD is the identity on ASCII and ASCII holds no
    // combining marks, so normalising and stripping are no-ops; per-char
    // A-Z lowering is toLowerCase, and each run of other characters is
    // one "-". Identical to the loop below, all in the regex engine.
    let out = text.toLowerCase().replace(NON_ALNUM_RUN_RE, '-').replace(EDGE_DASH_RE, '');
    if (out.length > 64) out = out.slice(0, 64).replace(TRAIL_DASH_RE, '');
    return out === '' ? 'untitled' : out;
  }
  const plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
    let keep = 0;
    if (code >= 65 && code <= 90) keep = code + 32;
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
    if (keep === 0) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  let end = out.length > 64 ? 64 : out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  out = out.slice(0, end);
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** Whether a code unit is whitespace, as JavaScript's \s sees it. */
function isWS(code) {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 0x00a0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    let ws;
    if (code < 128) ws = code === 32 || (code >= 9 && code <= 13);
    else
      ws =
        code === 0x00a0 ||
        code === 0x1680 ||
        (code >= 0x2000 && code <= 0x200a) ||
        code === 0x2028 ||
        code === 0x2029 ||
        code === 0x202f ||
        code === 0x205f ||
        code === 0x3000 ||
        code === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
// A relative path needs the slow split only when it holds a "." or ".."
// step, an empty step, or a trailing "/": one regex test settles it.
const SLOW_PATH_RE = /(^|\/)\.\.?(\/|$)|(\/\/)|(\/$)/;

function resolvePath(dir, rel) {
  // The common case: no "." or ".." step and no empty step, so the path is
  // just the directory and the relative path joined.
  if (!SLOW_PATH_RE.test(rel)) return dir === '' ? rel : `${dir}/${rel}`;
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/* ------------------------------------------------------------ front matter */

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function isDigit(code) {
  return code >= 48 && code <= 57;
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (const i of [0, 1, 2, 3, 5, 6, 8, 9]) {
          if (!isDigit(raw.charCodeAt(i))) {
            ok = false;
            break;
          }
        }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo))
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      let ok = raw.length > 0;
      if (ok) {
        for (let i = 0; i < raw.length; i++) {
          const c = raw.charCodeAt(i);
          if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) {
            ok = false;
            break;
          }
        }
      }
      return ok ? { value: raw } : { error: 'key "layout": not a template name' };
    }
    case 'slug': {
      let ok = raw.length > 0 && raw.length <= 64;
      if (ok) {
        let prevDash = true; // a slug may not open on "-"
        for (let i = 0; i < raw.length; i++) {
          const c = raw.charCodeAt(i);
          if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
          else if (c === 45 && !prevDash) prevDash = true;
          else {
            ok = false;
            break;
          }
        }
        if (prevDash) ok = false; // may not close on "-"
      }
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Whether the slice [s, e) of `text` holds only spaces and tabs. */
function onlySpacesTabs(text, s, e) {
  for (let i = s; i < e; i++) {
    const c = text.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const firstEnd = firstNl === -1 ? text.length : firstNl;
  if (firstEnd !== 3 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45)
    return { error: 'no front matter' };
  // Find the closing line, the next line that is exactly "---".
  let pos = firstEnd + 1;
  let lineNo = 1;
  let closeLine = -1;
  let closeEnd = -1;
  while (pos <= text.length) {
    const e = text.indexOf('\n', pos);
    const end = e === -1 ? text.length : e;
    if (end - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      closeLine = lineNo;
      closeEnd = end;
      break;
    }
    if (e === -1) break;
    pos = e + 1;
    lineNo++;
  }
  if (closeLine === -1) return { error: 'the front matter is not closed' };
  const data = {};
  // The head's lines, scanned in place: line i runs [pos, end). No slice
  // of the head and no per-line string: only the key and the value are
  // sliced out, as they must be.
  let lpos = firstEnd + 1;
  for (let i = 1; i < closeLine; i++) {
    const e = text.indexOf('\n', lpos);
    const end = e === -1 ? text.length : e;
    if (onlySpacesTabs(text, lpos, end) || text.charCodeAt(lpos) === 35) {
      lpos = end + 1;
      continue;
    }
    let k = 0;
    while (lpos + k < end) {
      const c = text.charCodeAt(lpos + k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || text.charCodeAt(lpos + k) !== 58) return { error: `line ${i + 1} is not "key: value"` };
    let raw;
    if (lpos + k + 1 === end) raw = '';
    else if (text.charCodeAt(lpos + k + 1) === 32) {
      let r = end;
      const rawStart = lpos + k + 2;
      while (r > rawStart) {
        const c = text.charCodeAt(r - 1);
        if (c === 32 || c === 9) r--;
        else break;
      }
      raw = text.slice(rawStart, r);
    } else return { error: `line ${i + 1} is not "key: value"` };
    const key = text.slice(lpos, lpos + k);
    if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
    lpos = end + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd < text.length ? text.slice(closeEnd + 1) : '' };
}

/* --------------------------------------------------------------- markdown */

// The characters a backslash escapes.
const ESCAPABLE = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE[ch.charCodeAt(0)] = 1;

/** Whether the line [s, e) of `src` is blank (spaces and tabs only). */
function isBlank(src, s, e) {
  return onlySpacesTabs(src, s, e);
}

/** A fence's language, or null when the line [s, e) does not open one. */
function fenceOpen(src, s, e) {
  if (e - s < 3 || src.charCodeAt(s) !== 96 || src.charCodeAt(s + 1) !== 96 || src.charCodeAt(s + 2) !== 96) return null;
  let i = s + 3;
  while (i < e) {
    const c = src.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = src.slice(s + 3, i);
  while (i < e) {
    const c = src.charCodeAt(i);
    if (c === 32 || c === 9) i++;
    else return null;
  }
  return lang;
}

/** Whether the line [s, e) closes a fence. */
function isFenceClose(src, s, e) {
  if (e - s < 3 || src.charCodeAt(s) !== 96 || src.charCodeAt(s + 1) !== 96 || src.charCodeAt(s + 2) !== 96) return false;
  for (let i = s + 3; i < e; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(src, s, e) {
  let i = s;
  let depth = 0;
  while (i < e && src.charCodeAt(i) === 35 && depth < 7) {
    depth++;
    i++;
  }
  if (depth === 0 || depth > 6) return null;
  if (i >= e || (src.charCodeAt(i) !== 32 && src.charCodeAt(i) !== 9)) return null;
  while (i < e && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
  let j = e;
  while (j > i && (src.charCodeAt(j - 1) === 32 || src.charCodeAt(j - 1) === 9)) j--;
  if (j === i) return null;
  return { depth, text: src.slice(i, j) };
}

/** Whether the line [s, e) is a thematic break. */
function isHR(src, s, e) {
  if (e - s < 3) return false;
  const c = src.charCodeAt(s);
  if (c !== 45 && c !== 42) return false;
  if (src.charCodeAt(s + 1) !== c || src.charCodeAt(s + 2) !== c) return false;
  for (let i = s + 3; i < e; i++) {
    const ch = src.charCodeAt(i);
    if (ch !== 32 && ch !== 9) return false;
  }
  return true;
}

/** Whether the line [s, e) ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(src, s, e) {
  if (s >= e) return true;
  const c = src.charCodeAt(s);
  if (c === 32 || c === 9) return isBlank(src, s, e);
  if (c === 96) return fenceOpen(src, s, e) !== null;
  if (c === 35) return headingOf(src, s, e) !== null;
  if (c === 45 || c === 42) return isHR(src, s, e);
  return false;
}

/** The line [s, e) with spaces and tabs at either end dropped. */
function trimLine(src, s, e) {
  while (s < e && (src.charCodeAt(s) === 32 || src.charCodeAt(s) === 9)) s++;
  while (e > s && (src.charCodeAt(e - 1) === 32 || src.charCodeAt(e - 1) === 9)) e--;
  return src.slice(s, e);
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1.
 * Found with indexOf: a candidate is escaped exactly when the run of
 * backslashes just before it is odd (each pair cancels, a leftover one
 * escapes `what`'s first character, which is escapable for '**' and ']').
 * The run cannot reach back before `from`: the character there is the
 * construct that opened the search, never a backslash. */
function findUnescaped(s, what, from) {
  let k = from;
  for (;;) {
    k = s.indexOf(what, k);
    if (k === -1) return -1;
    let b = 0;
    for (let q = k - 1; q >= from && s.charCodeAt(q) === 92; q--) b++;
    if ((b & 1) === 0) return k;
    k++;
  }
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1.
 * Found with indexOf, the same odd-backslash rule as findUnescaped: a
 * star preceded by an odd run of backslashes is escaped, and a star
 * followed by another star is half of a ** pair, skipped as one. */
function findSingleStar(s, from) {
  let k = from;
  for (;;) {
    k = s.indexOf('*', k);
    if (k === -1) return -1;
    let b = 0;
    for (let q = k - 1; q >= from && s.charCodeAt(q) === 92; q--) b++;
    if ((b & 1) === 1) {
      k++;
      continue;
    }
    if (s.charCodeAt(k + 1) === 42) {
      k += 2;
      continue;
    }
    return k;
  }
}

const WS_TEST = /\s/;

// The characters that can start an inline construct or need escaping. The
// scan for the next one runs in the regular-expression engine; everything
// between two of them is plain text and is copied whole.
const SPECIAL_RE = /[\\`*\[&<>"']/g;

/**
 * `s` rendered inline, appended to `out`. `C` carries the case state; `dir`
 * is the source's directory and `srcPath` its path, for link resolution.
 * The one shared regular expression is re-entrant: every recursive call
 * restarts it, and every branch resets its position before continuing, so
 * an inner render cannot disturb the outer scan.
 */
function inlineInto(s, C, dir, srcPath, out) {
  const RE = SPECIAL_RE;
  RE.lastIndex = 0;
  let i = 0;
  const n = s.length;
  let m;
  while ((m = RE.exec(s)) !== null) {
    const j = m.index;
    const c = s.charCodeAt(j);
    if (c === 92) {
      // A backslash before an escapable character writes that character.
      if (j + 1 < n && ESCAPABLE[s.charCodeAt(j + 1)] === 1) {
        if (j > i) out.push(s.slice(i, j));
        out.push(s[j + 1]);
        i = j + 2;
        RE.lastIndex = i;
      } else RE.lastIndex = j + 1; // the backslash itself stays in the run
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (j > i) out.push(s.slice(i, j));
        out.push('<code>', esc(s.slice(j + 1, k)), '</code>');
        i = k + 1;
        RE.lastIndex = i;
      } else RE.lastIndex = j + 1; // no closer: the backtick stays
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          if (j > i) out.push(s.slice(i, j));
          out.push('<strong>');
          inlineInto(s.slice(j + 2, k), C, dir, srcPath, out);
          out.push('</strong>');
          i = k + 2;
          RE.lastIndex = i;
        } else RE.lastIndex = j + 2; // no closer: both stars stay
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        if (j > i) out.push(s.slice(i, j));
        out.push('<em>');
        inlineInto(s.slice(j + 1, k), C, dir, srcPath, out);
        out.push('</em>');
        i = k + 1;
        RE.lastIndex = i;
      } else RE.lastIndex = j + 1; // no closer: the star stays
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', j + 1);
      let mm = -1;
      let target = '';
      if (k !== -1 && s.charCodeAt(k + 1) === 40) {
        mm = s.indexOf(')', k + 2);
        target = mm === -1 ? '' : s.slice(k + 2, mm);
      }
      if (mm !== -1 && target !== '' && !WS_TEST.test(target)) {
        if (j > i) out.push(s.slice(i, j));
        out.push('<a href="', esc(resolveLink(C, dir, srcPath, target)), '">');
        inlineInto(s.slice(j + 1, k), C, dir, srcPath, out);
        out.push('</a>');
        i = mm + 1;
        RE.lastIndex = i;
      } else RE.lastIndex = j + 1; // no link: the bracket stays
      continue;
    }
    if (j > i) out.push(s.slice(i, j));
    out.push(ESCAPES[s[j]]);
    i = j + 1;
    RE.lastIndex = i;
  }
  if (n > i) out.push(s.slice(i, n));
}

/** `s` rendered inline, as a string. */
function inlineStr(s, C, dir, srcPath) {
  const out = [];
  inlineInto(s, C, dir, srcPath, out);
  return out.join('');
}

/** Whether `target` opens with a scheme (`https:`, `mailto:` ...). */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** A link's href, resolving a relative target against the source's directory. */
function resolveLink(C, dir, srcPath, target) {
  if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
  // The href of a RESOLVED link depends only on (dir, target) within a
  // case, and the same pair recurs across bodies, so memoise it: two map
  // gets instead of a path resolution. Broken links are NOT memoised:
  // their report entry names the source file, so the same pair from
  // another source is a different entry and must be recorded again.
  let byDir = C.linkCache.get(dir);
  if (byDir === undefined) {
    byDir = new Map();
    C.linkCache.set(dir, byDir);
  }
  const hit = byDir.get(target);
  if (hit !== undefined) return hit;
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  const path = rel === '' ? null : resolvePath(dir, rel);
  if (path !== null) {
    const pg = C.bySource.get(path);
    if (pg !== undefined) {
      const href = `${pg.url}${frag}`;
      byDir.set(target, href);
      return href;
    }
    if (C.staticPaths.has(path)) {
      const href = `${C.base}/${path}${frag}`;
      byDir.set(target, href);
      return href;
    }
  }
  C.broken.add(`broken-link ${srcPath} -> ${target}`);
  return target;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading) and its excerpt
 * (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, C, dir, srcPath) {
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  const len = src.length;
  let pos = 0;
  while (pos < len) {
    let e = src.indexOf('\n', pos);
    if (e === -1) e = len;
    const ls = pos;
    const le = e;
    // The block a line starts is decided by its first character: a line
    // opening on a space or tab is blank or a paragraph line, and only
    // that; every other block needs its own opening character.
    const c0 = ls < le ? src.charCodeAt(ls) : 32;
    if (c0 === 32 || c0 === 9) {
      if (isBlank(src, ls, le)) {
        pos = le + 1;
        continue;
      }
    } else if (c0 === 96) {
      const lang = fenceOpen(src, ls, le);
      if (lang !== null) {
        // Scan for the closing fence without slicing, then take the body
        // as one slice and escape it once: the old code escaped line by
        // line. Identical output: esc never touches "\n", and every body
        // line gains exactly one "\n" (appended when the last line lacks
        // one, as at end of input).
        const bodyStart = le + 1;
        let bodyEnd = len;
        pos = le + 1;
        while (pos < len) {
          let e2 = src.indexOf('\n', pos);
          if (e2 === -1) e2 = len;
          if (isFenceClose(src, pos, e2)) {
            bodyEnd = pos;
            pos = e2 + 1;
            break;
          }
          pos = e2 + 1;
        }
        let body = bodyEnd > bodyStart ? src.slice(bodyStart, bodyEnd) : '';
        if (body !== '' && body.charCodeAt(body.length - 1) !== 10) body += '\n';
        out.push(`<pre><code${lang === '' ? '' : ` class="language-${esc(lang)}"`}>`);
        if (body !== '') out.push(esc(body));
        out.push('</code></pre>\n');
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(src, ls, le);
      if (heading !== null) {
        const id = uniqueSlug(slugifyCached(C, heading.text), ids);
        const html = inlineStr(heading.text, C, dir, srcPath);
        out.push(`<h${heading.depth} id="${id}">`, html, `</h${heading.depth}>\n`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        pos = le + 1;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHR(src, ls, le)) {
        out.push('<hr>\n');
        pos = le + 1;
        continue;
      }
    } else if (c0 === 62) {
      const qlines = [];
      while (pos < len) {
        let e2 = src.indexOf('\n', pos);
        if (e2 === -1) e2 = len;
        if (src.charCodeAt(pos) !== 62) break;
        let t = pos + 1;
        if (t < e2 && src.charCodeAt(t) === 32) t++;
        const line = trimLine(src, t, e2);
        if (line !== '') qlines.push(line);
        pos = e2 + 1;
        if (pos >= len) break;
        if (src.charCodeAt(pos) !== 62) break;
      }
      if (qlines.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        out.push('<blockquote>\n<p>');
        inlineInto(qlines.join('\n'), C, dir, srcPath, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    // A list: a bullet line, or an ordered line, and its continuations.
    let isOrdered = false;
    let start = 1;
    let firstItem = null;
    if ((c0 === 45 || c0 === 42) && le - ls >= 2 && src.charCodeAt(ls + 1) === 32) {
      firstItem = trimLine(src, ls + 2, le);
    } else {
      let i = ls;
      let nd = 0;
      while (i < le && isDigit(src.charCodeAt(i)) && nd < 10) {
        i++;
        nd++;
      }
      if (nd >= 1 && nd <= 9 && i < le && src.charCodeAt(i) === 46 && i + 1 < le && src.charCodeAt(i + 1) === 32) {
        isOrdered = true;
        start = Number(src.slice(ls, i));
        firstItem = trimLine(src, i + 2, le);
      }
    }
    if (firstItem !== null) {
      const items = [firstItem];
      pos = le + 1;
      while (pos < len) {
        let e2 = src.indexOf('\n', pos);
        if (e2 === -1) e2 = len;
        let m = null;
        if (isOrdered) {
          let i = pos;
          let nd = 0;
          while (i < e2 && isDigit(src.charCodeAt(i)) && nd < 10) {
            i++;
            nd++;
          }
          if (nd >= 1 && nd <= 9 && i < e2 && src.charCodeAt(i) === 46 && i + 1 < e2 && src.charCodeAt(i + 1) === 32) m = trimLine(src, i + 2, e2);
        } else {
          const cc = src.charCodeAt(pos);
          if ((cc === 45 || cc === 42) && e2 - pos >= 2 && src.charCodeAt(pos + 1) === 32) m = trimLine(src, pos + 2, e2);
        }
        if (m !== null) {
          items.push(m);
          pos = e2 + 1;
          continue;
        }
        // A line of two or more spaces then a non-space continues the item.
        let j = pos;
        while (j < e2 && src.charCodeAt(j) === 32) j++;
        if (j - pos >= 2 && j < e2 && !isWS(src.charCodeAt(j))) {
          items[items.length - 1] += `\n${trimLine(src, pos, e2)}`;
          pos = e2 + 1;
          continue;
        }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      out.push(isOrdered && start !== 1 ? `<ol start="${start}">\n` : `<${tag}>\n`);
      for (const item of items) {
        out.push('<li>');
        inlineInto(item, C, dir, srcPath, out);
        out.push('</li>\n');
      }
      out.push(`</${tag}>\n`);
      continue;
    }
    // A paragraph: this line and the lines after it up to a blank line, a
    // fence, a heading or a thematic break.
    const parts = [trimLine(src, ls, le)];
    pos = le + 1;
    while (pos < len) {
      let e2 = src.indexOf('\n', pos);
      if (e2 === -1) e2 = len;
      if (endsParagraph(src, pos, e2)) break;
      parts.push(trimLine(src, pos, e2));
      pos = e2 + 1;
    }
    const text = parts.join('\n');
    if (excerpt === null) {
      // The first paragraph is also the excerpt, so it is rendered to a
      // string; every later paragraph renders straight into the output.
      const html = inlineStr(text, C, dir, srcPath);
      excerpt = html;
      out.push('<p>', html, '</p>\n');
    } else {
      out.push('<p>');
      inlineInto(text, C, dir, srcPath, out);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

/* -------------------------------------------------------------- templates */

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === n - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src.charCodeAt(open + 2) === 123;
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') {
        tokens.push({ t: 'text', text });
        text = '';
      }
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? n : nl;
    const standalone = onlySpacesTabs(src, lineStart, open) && onlySpacesTabs(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') {
      tokens.push({ t: 'text', text });
      text = '';
    }
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? n : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

// Node kinds: 0 text, 1 var, 2 raw, 3 if, 4 for, 5 include, 6 root.
/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { k: 6, body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') {
      body.push({ k: 0, text: tok.text });
      continue;
    }
    if (tok.t === 'var' || tok.t === 'raw') {
      body.push({ k: tok.t === 'var' ? 1 : 2, p: tok.path });
      continue;
    }
    const tag = tok.tag;
    const top = stack[stack.length - 1];
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = { k: 4, name: m[1], p: pathOf(name, m[2]), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = { k: 3, not: m[1] !== undefined, p: pathOf(name, m[2]), then: [], els: null };
      body.push(node);
      stack.push(node);
      body = node.then;
    } else if (tag === 'else') {
      if (top.k !== 3 || top.els !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top.els = [];
      body = top.els;
    } else if (tag === 'endfor' || tag === 'endif') {
      if (top.k !== (tag === 'endfor' ? 4 : 3)) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.k === 6 ? parent.body : parent.k === 4 ? parent.body : parent.els ?? parent.then;
    } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
      body.push({ k: 5, name: m[1] });
    } else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].k === 4 ? 'for' : 'if'} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** The value of the single name `name` in the scope chain. */
function lookupName(scope, name) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, name)) s = s.parent;
  return s === null ? undefined : s.vars[name];
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The names a template reads directly (not bound by its own fors) into `out`; include names into `incs`. */
function scanRefs(nodes, bound, out, incs) {
  for (const nd of nodes) {
    if (nd.k === 1 || nd.k === 2) {
      if (!bound.has(nd.p[0])) out.add(nd.p[0]);
    } else if (nd.k === 3) {
      if (!bound.has(nd.p[0])) out.add(nd.p[0]);
      scanRefs(nd.then, bound, out, incs);
      if (nd.els !== null) scanRefs(nd.els, bound, out, incs);
    } else if (nd.k === 4) {
      if (!bound.has(nd.p[0])) out.add(nd.p[0]);
      const b2 = new Set(bound);
      b2.add(nd.name);
      b2.add('loop');
      scanRefs(nd.body, b2, out, incs);
    } else if (nd.k === 5) {
      incs.add(nd.name);
    }
  }
}

/**
 * A template record's free names: every name its rendering can read that is
 * not bound inside the template itself. Computed as the union of the direct
 * names over the template and every template it includes, transitively — a
 * safe over-approximation (a name bound by an includer's loop is still
 * listed, so the cache key below stays exact).
 */
function computeFreeNames(templates) {
  for (const t of templates.values()) {
    const direct = new Set();
    const incs = new Set();
    scanRefs(t.nodes, new Set(), direct, incs);
    t.freeSet = direct;
    t.includes = [...incs];
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of templates.values()) {
      for (const name of t.includes) {
        const u = templates.get(name);
        if (u === undefined) continue;
        for (const f of u.freeSet) {
          if (!t.freeSet.has(f)) {
            t.freeSet.add(f);
            changed = true;
          }
        }
      }
    }
  }
  for (const t of templates.values()) t.free = [...t.freeSet].sort();
}

// The deepest an include nests: one past it renders nothing.
const INCLUDE_DEPTH = 8;
// Sentinel key for a cached render's stored string.
const LEAF = {};

/**
 * `t` rendered in `scope` at include depth `depth`, appended to `out`.
 * The render depends only on the values of the template's free names (and
 * the depth), so renders with the same key are reused from the per-case
 * cache instead of being walked again.
 */
function renderIncluded(t, scope, out, depth, C) {
  let node = t.cache.get(depth);
  if (node === undefined) {
    node = new Map();
    t.cache.set(depth, node);
  }
  for (let fi = 0; fi < t.free.length; fi++) {
    const v = lookupName(scope, t.free[fi]);
    let next = node.get(v);
    if (next === undefined) {
      next = new Map();
      node.set(v, next);
    }
    node = next;
  }
  let s = node.get(LEAF);
  if (s === undefined) {
    const tmp = [];
    renderNodes(t.nodes, scope, tmp, depth, C);
    s = tmp.join('');
    node.set(LEAF, s);
  }
  out.push(s);
}

/** `nodes` rendered in `scope` ({ vars, parent }), appended to `out`. */
function renderNodes(nodes, scope, out, depth, C) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const nd = nodes[ni];
    switch (nd.k) {
      case 0:
        out.push(nd.text);
        break;
      case 1:
        out.push(esc(textOf(lookup(scope, nd.p))));
        break;
      case 2:
        out.push(textOf(lookup(scope, nd.p)));
        break;
      case 3: {
        const v = truthy(lookup(scope, nd.p));
        const branch = v !== nd.not ? nd.then : nd.els;
        if (branch !== null) renderNodes(branch, scope, out, depth, C);
        break;
      }
      case 4: {
        const xs = lookup(scope, nd.p);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = {};
          vars[nd.name] = xs[k];
          vars.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
          renderNodes(nd.body, { vars, parent: scope }, out, depth, C);
        }
        break;
      }
      case 5: {
        const t = C.templates.get(nd.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderIncluded(t, scope, out, depth + 1, C);
        break;
      }
    }
  }
}

/* ------------------------------------------------------------------- build */

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** A post's card, as lists show it. */
function cardOf(C, s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDateCached(C, s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    // reading_minutes is read only by the post template (a post's own
    // page) and the card template (a post's card); a non-post page whose
    // layout is not "post" never renders it, so its word count is skipped.
    // The 1 below is never rendered.
    reading_minutes: s.post || s.layout === 'post' ? Math.max(1, Math.ceil(wordsOf(s.body) / 200)) : 1,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page's link record as templates read it. */
function linkOf(C, s) {
  return s === null
    ? null
    : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDateCached(C, s.data.date) };
}

/** A page as its layout reads it. */
function pageOf(C, s) {
  const card = s.post ? C.cards.get(s) : cardOf(C, s);
  return {
    ...card,
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(C, s.newer ?? null),
    older: linkOf(C, s.older ?? null),
    is_post: s.post,
  };
}

function slugifyCached(C, text) {
  let v = C.slugCache.get(text);
  if (v === undefined) {
    v = slugifyRaw(text);
    C.slugCache.set(text, v);
  }
  return v;
}

function longDateCached(C, date) {
  let v = C.dateCache.get(date);
  if (v === undefined) {
    v = longDateRaw(date);
    C.dateCache.set(date, v);
  }
  return v;
}

/** One site's output tree: path -> text. */
export function run(input) {
  const C = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates: new Map(),
    report: [],
    broken: new Set(),
    bySource: new Map(),
    linkCache: new Map(),
    staticPaths: new Set(),
    sources: [],
    statics: [],
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
    slugCache: new Map(),
    dateCache: new Map(),
  };

  // Templates, parsed in code-unit order of their name. One that does not
  // parse is reported and left out, as if it were not there.
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      C.templates.set(name, { nodes: parseTemplate(name, input.templates[name]), free: [], freeSet: null, includes: [], cache: new Map() });
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      C.report.push(err.message);
    }
  }
  computeFreeNames(C.templates);

  // Sources, in code-unit order of their paths, line ends made "\n"; a
  // source that is not .md is static.
  const files = [...input.files].sort((a, b) => byCodeUnits(a.path, b.path));
  for (const f of files) {
    if (f.path.endsWith('.md'))
      C.sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else C.statics.push({ path: f.path, content: f.content });
  }
  for (const f of C.statics) C.staticPaths.add(f.path);

  // Each source's front matter: a refused source is reported and dropped,
  // and so is a draft. The checks run in order; the first that fails is
  // the one reported.
  const kept = [];
  for (const s of C.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      C.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      C.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      C.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!C.templates.has(layout)) {
      C.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      C.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  C.sources = kept;

  // Each page's output directory and url: its slug made unique in its
  // directory, in source order.
  const taken = new Map();
  for (const s of C.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugifyCached(C, s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${C.base}/${s.outDir}/`;
    C.bySource.set(s.path, s);
  }

  // Each body's Markdown, its links resolved to the pages and static files
  // they name.
  for (const s of C.sources) {
    const md = renderMarkdown(s.body, C, dirOf(s.path), s.path);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // The posts, newest first and then by slug; each post's newer and older
  // neighbours.
  const posts = C.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  C.posts = posts;
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // The tags: grouped by their slug, each named as first met in the posts'
  // order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const res = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugifyCached(C, name);
      if (!seen.has(slug)) {
        seen.add(slug);
        res.push(name);
      }
    }
    return res;
  };
  for (const p of C.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugifyCached(C, name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${C.base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of C.sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugifyCached(C, name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  C.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Every page through its layout, the index pages and the tag pages
  // through theirs.
  for (const p of C.posts) C.cards.set(p, cardOf(C, p));
  const site = { title: C.input.site.title, base_url: C.base };
  const allTags = C.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = C.posts.slice(0, C.input.site.recent).map((p) => C.cards.get(p));
  const render = (name, vars) => {
    const t = C.templates.get(name);
    if (t === undefined) return null;
    const out = [];
    renderNodes(t.nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, out, 0, C);
    return out.join('');
  };
  for (const s of C.sources) C.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(C, s) });
  const per = C.input.site.per_page;
  const pages = Math.max(1, Math.ceil(C.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${C.base}/` : `${C.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: C.posts.slice((k - 1) * per, k * per).map((p) => C.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) C.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of C.tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => C.cards.get(p)) },
    });
    if (html !== null) C.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) C.output['tags/index.html'] = tagsHtml;
  for (const f of C.statics) {
    if (Object.hasOwn(C.output, f.path)) C.report.push(`shadowed ${f.path}: a built page has its path`);
    else C.output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not
  // parse, sorted, then the counts.
  const lines = [...C.report, ...C.broken].sort(byCodeUnits);
  const pageCount = C.sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${C.posts.length} posts, ${C.tags.length} tags and ${C.statics.length} static files`);
  C.output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return C.output;
}
