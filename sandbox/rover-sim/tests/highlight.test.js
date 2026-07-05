/**
 * JS シンタックスハイライタのテスト
 */
import { createTestRunner, assert } from './test-runner.js';
import { escapeHtml, tokenize, highlight } from '../highlight.js';

const { runner, describe, it } = createTestRunner();

/** ハイライト HTML からタグを除去しエンティティを戻す (往復検証用) */
function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

describe('escapeHtml', () => {
  it('HTML 特殊文字をエスケープする', () => {
    assert.equal(escapeHtml('<&>"'), '&lt;&amp;&gt;&quot;');
  });
});

describe('tokenize', () => {
  it('トークンを連結すると元のソースに一致する (無損失)', () => {
    const src = `// comment\nconst s = "a\\"b" + 'c<d';\nlet n = 0x1f + 1.5e-3;\n/* block\n comment */\nrover.setWheels(1, 2);\n\`tpl \${x}\`\n`;
    const joined = tokenize(src).map((t) => t.value).join('');
    assert.equal(joined, src);
  });

  it('キーワードを認識する', () => {
    const toks = tokenize('const x = 1;');
    const kw = toks.find((t) => t.type === 'keyword');
    assert.truthy(kw);
    assert.equal(kw.value, 'const');
  });

  it('キーワードを含む識別子はキーワード扱いしない', () => {
    const toks = tokenize('constant');
    assert.equal(toks.length, 1);
    assert.equal(toks[0].type, 'ident');
  });

  it('数値リテラルを認識する (整数・小数・16進・指数)', () => {
    for (const src of ['42', '3.14', '0xff', '1.5e-3']) {
      const toks = tokenize(src);
      assert.equal(toks[0].type, 'number', src);
      assert.equal(toks[0].value, src, src);
    }
  });

  it('文字列リテラルを 1 トークンにする (エスケープ込み)', () => {
    const toks = tokenize('"a\\"b"');
    assert.equal(toks.length, 1);
    assert.equal(toks[0].type, 'string');
  });

  it('テンプレートリテラルは改行をまたげる', () => {
    const toks = tokenize('`line1\nline2`');
    assert.equal(toks.length, 1);
    assert.equal(toks[0].type, 'string');
  });

  it('行コメントとブロックコメントを認識する', () => {
    assert.equal(tokenize('// hi')[0].type, 'comment');
    assert.equal(tokenize('/* a\nb */')[0].type, 'comment');
  });

  it('組み込みオブジェクトを認識する', () => {
    const toks = tokenize('Math.floor(x)');
    assert.equal(toks[0].type, 'builtin');
    assert.equal(toks[0].value, 'Math');
  });
});

describe('highlight', () => {
  it('キーワードと数値に span が付く', () => {
    const html = highlight('const x = 42;');
    assert.true(html.includes('<span class="tok-keyword">const</span>'));
    assert.true(html.includes('<span class="tok-number">42</span>'));
  });

  it('コメントに span が付く', () => {
    const html = highlight('// note');
    assert.true(html.includes('tok-comment'));
  });

  it('文字列内の HTML はエスケープされる (XSS しない)', () => {
    const html = highlight('const s = "<script>alert(1)</script>";');
    assert.false(html.includes('<script>'));
    assert.true(html.includes('&lt;script&gt;'));
  });

  it('タグを剥がすと元のソースに戻る (表示ずれしない)', () => {
    const src = `function loop(rover, dt) {\n  // 50% で "前進"\n  const v = rover.time < 2 ? 0.3 : -0.3;\n  rover.setWheels(v, v); /* a<b && c>'d' */\n}\n`;
    assert.equal(stripHtml(highlight(src)), src);
  });
});

export { runner };
