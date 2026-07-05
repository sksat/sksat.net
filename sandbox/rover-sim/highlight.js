/**
 * 軽量 JS シンタックスハイライタ + コードエディタ
 *
 * tokenize / highlight は DOM 非依存 (tests/ から使う)。
 * CodeEditor は textarea の背後にハイライト済み <pre> を重ねる方式。
 */

const KEYWORDS = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends',
  'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let',
  'new', 'of', 'return', 'static', 'super', 'switch', 'throw', 'try',
  'typeof', 'var', 'void', 'while', 'with', 'yield',
]);

const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity', 'this']);

const BUILTINS = new Set([
  'Math', 'JSON', 'console', 'Object', 'Array', 'String', 'Number', 'Boolean',
  'Date', 'Map', 'Set', 'Promise', 'RegExp', 'Error', 'Symbol', 'BigInt',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'window', 'document', 'globalThis',
]);

const NUMBER_RE = /(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*\.?[\d_]*(?:[eE][+-]?\d+)?|\.\d[\d_]*(?:[eE][+-]?\d+)?)/y;
const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/y;
const SPACE_RE = /[^\S\n]+|\n+/y;

export function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function scanString(src, i) {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === quote) {
      j++;
      break;
    }
    if (quote !== '`' && c === '\n') break; // 未終端の通常文字列は行末まで
    j++;
  }
  return Math.min(j, src.length);
}

/**
 * JS ソースをトークン列に分解する。トークンの value を連結すると必ず元のソースに戻る。
 * @returns {Array<{type: string, value: string}>}
 */
export function tokenize(src) {
  const tokens = [];
  const n = src.length;
  let i = 0;

  const push = (type, value) => {
    if (value) tokens.push({ type, value });
  };

  while (i < n) {
    const ch = src[i];

    if (ch === '/' && src[i + 1] === '/') {
      let j = src.indexOf('\n', i);
      if (j === -1) j = n;
      push('comment', src.slice(i, j));
      i = j;
      continue;
    }

    if (ch === '/' && src[i + 1] === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j === -1 ? n : j + 2;
      push('comment', src.slice(i, j));
      i = j;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      const j = scanString(src, i);
      push('string', src.slice(i, j));
      i = j;
      continue;
    }

    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      NUMBER_RE.lastIndex = i;
      const m = NUMBER_RE.exec(src);
      if (m) {
        push('number', m[0]);
        i += m[0].length;
        continue;
      }
    }

    if (/[A-Za-z_$]/.test(ch)) {
      IDENT_RE.lastIndex = i;
      const m = IDENT_RE.exec(src);
      const word = m[0];
      let type = 'ident';
      if (KEYWORDS.has(word)) type = 'keyword';
      else if (LITERALS.has(word)) type = 'literal';
      else if (BUILTINS.has(word)) type = 'builtin';
      push(type, word);
      i += word.length;
      continue;
    }

    SPACE_RE.lastIndex = i;
    const sp = SPACE_RE.exec(src);
    if (sp) {
      push('space', sp[0]);
      i += sp[0].length;
      continue;
    }

    push('op', ch);
    i++;
  }

  return tokens;
}

const TOKEN_CLASS = {
  keyword: 'tok-keyword',
  literal: 'tok-literal',
  builtin: 'tok-builtin',
  string: 'tok-string',
  number: 'tok-number',
  comment: 'tok-comment',
};

/** JS ソースをハイライト済み HTML にする */
export function highlight(src) {
  let html = '';
  for (const tok of tokenize(src)) {
    const cls = TOKEN_CLASS[tok.type];
    const escaped = escapeHtml(tok.value);
    html += cls ? `<span class="${cls}">${escaped}</span>` : escaped;
  }
  return html;
}

/**
 * シンタックスハイライト付きコードエディタ。
 * 透明な textarea を最前面に置き、背後の <pre> にハイライトを描く。
 */
export class CodeEditor {
  constructor(root, { value = '', onChange = null } = {}) {
    this.onChange = onChange;

    root.classList.add('code-editor');

    this.pre = document.createElement('pre');
    this.pre.className = 'ce-highlight';
    this.pre.setAttribute('aria-hidden', 'true');
    this.code = document.createElement('code');
    this.pre.appendChild(this.code);

    this.textarea = document.createElement('textarea');
    this.textarea.className = 'ce-input';
    this.textarea.spellcheck = false;
    this.textarea.wrap = 'off';
    this.textarea.setAttribute('autocapitalize', 'off');
    this.textarea.setAttribute('autocomplete', 'off');
    this.textarea.setAttribute('autocorrect', 'off');

    root.append(this.pre, this.textarea);

    this.textarea.addEventListener('input', () => this._render());
    this.textarea.addEventListener('scroll', () => this._syncScroll());
    this.textarea.addEventListener('keydown', (e) => this._onKeydown(e));

    this.setValue(value);
  }

  getValue() {
    return this.textarea.value;
  }

  setValue(value) {
    this.textarea.value = value;
    this._render();
  }

  _onKeydown(e) {
    if (e.key === 'Tab') {
      e.preventDefault();
      this._insert('  ');
    } else if (e.key === 'Enter') {
      // オートインデント: 直前の行の先頭空白を引き継ぐ
      e.preventDefault();
      const ta = this.textarea;
      const before = ta.value.slice(0, ta.selectionStart);
      const line = before.slice(before.lastIndexOf('\n') + 1);
      const indent = /^[ \t]*/.exec(line)[0];
      this._insert('\n' + indent);
    }
  }

  _insert(text) {
    const ta = this.textarea;
    ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
    this._render();
  }

  _render() {
    // 末尾に改行を足しておくと最終行のスクロールがずれない
    this.code.innerHTML = highlight(this.textarea.value + '\n');
    this._syncScroll();
    if (this.onChange) this.onChange(this.getValue());
  }

  _syncScroll() {
    this.pre.scrollTop = this.textarea.scrollTop;
    this.pre.scrollLeft = this.textarea.scrollLeft;
  }
}
