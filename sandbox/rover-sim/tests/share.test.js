/**
 * URL 共有コーデックのテスト
 */
import { createTestRunner, assert } from './test-runner.js';
import {
  encodeText,
  decodeText,
  buildShareUrl,
  PARAM_WORLD,
  PARAM_FIRMWARE,
  PARAM_SAMPLE,
} from '../share.js';
import { SAMPLES, findSample } from '../samples.js';

const { runner, describe, it } = createTestRunner();

describe('encodeText / decodeText (コードの base64url 符号化)', () => {
  it('往復でコードが一致する', async () => {
    const src = 'function loop(rover, dt) {\n  rover.set("motor-left", 0.6);\n}';
    assert.equal(await decodeText(await encodeText(src)), src);
  });

  it('日本語・改行・記号を含むコードも往復できる', async () => {
    const src = '// マップ定義 🚀\nconst map = { ground(x, y) { return "#fff"; } };\n// 記号 <>&\'"`${}+/=?& ';
    assert.equal(await decodeText(await encodeText(src)), src);
  });

  it('ペイロードは URL セーフな文字だけで構成される', async () => {
    const payload = await encodeText('あいうえお'.repeat(100) + '+/=?&# ');
    assert.true(/^[01]-[A-Za-z0-9_-]+$/.test(payload), `URL セーフ (${payload.slice(0, 40)}...)`);
  });

  it('圧縮が効く (繰り返しの多いコードは元のサイズより短い)', async () => {
    const src = 'rover.set("motor-left", 0.5);\n'.repeat(200);
    const payload = await encodeText(src);
    assert.true(payload.length < src.length, `圧縮されている (${payload.length} < ${src.length})`);
    assert.true(payload.startsWith('1-'), '圧縮版のプレフィックス');
  });

  it('無圧縮フォーマット (0- プレフィックス) も読める', async () => {
    const src = 'const map = 1; // あ';
    const b64url = btoa(String.fromCharCode(...new TextEncoder().encode(src)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    assert.equal(await decodeText(`0-${b64url}`), src);
  });

  it('壊れたペイロードはエラーになる', async () => {
    await assert.throwsAsync(() => decodeText('garbage'));
    await assert.throwsAsync(() => decodeText('9-AAAA'));
    await assert.throwsAsync(() => decodeText('1-!!!!'));
    await assert.throwsAsync(() => decodeText('1-AAAAAAAA')); // deflate として不正
  });
});

describe('buildShareUrl', () => {
  it('設定は素のクエリ、コードは base64 パラメータとして並ぶ', async () => {
    const world = await encodeText('const map = {};');
    const firmware = await encodeText('function loop() {}');
    const url = buildShareUrl('https://sksat.net/sandbox/rover-sim/', {
      speed: 4,
      view: 'temp',
      [PARAM_WORLD]: world,
      [PARAM_FIRMWARE]: firmware,
    });
    assert.true(url.includes('speed=4'), '設定は読めるクエリのまま');
    assert.true(url.includes('view=temp'));
    assert.true(url.includes(`${PARAM_WORLD}=1-`) || url.includes(`${PARAM_WORLD}=0-`));
    const params = new URLSearchParams(url.split('?')[1]);
    assert.equal(await decodeText(params.get(PARAM_WORLD)), 'const map = {};');
    assert.equal(await decodeText(params.get(PARAM_FIRMWARE)), 'function loop() {}');
  });

  it('既存のクエリ・ハッシュは除去される', () => {
    const url = buildShareUrl('https://sksat.net/sandbox/rover-sim/?speed=1&world=old#x', { speed: 2 });
    assert.equal(url, 'https://sksat.net/sandbox/rover-sim/?speed=2');
  });

  it('undefined / 空のパラメータは省かれる', () => {
    const url = buildShareUrl('http://localhost:8000/a/', { speed: 4, view: undefined, world: '' });
    assert.equal(url, 'http://localhost:8000/a/?speed=4');
  });
});

describe('サンプル選択だけの共有', () => {
  it('スクリプトが未編集のサンプルと一致すればサンプルを特定できる', () => {
    const s = SAMPLES[0];
    assert.equal(findSample(s.world, s.firmware), s);
  });

  it('少しでも編集されていたらサンプル扱いしない', () => {
    const s = SAMPLES[0];
    assert.equal(findSample(s.world + '\n// edit', s.firmware), null);
    assert.equal(findSample(s.world, s.firmware + ' '), null);
  });

  it('サンプル選択だけの URL はコードを含まず sample= だけになる', () => {
    const url = buildShareUrl('https://sksat.net/sandbox/rover-sim/', {
      [PARAM_SAMPLE]: 'linetrace',
      speed: 2,
      view: 'color',
    });
    assert.equal(url, 'https://sksat.net/sandbox/rover-sim/?sample=linetrace&speed=2&view=color');
    assert.false(url.includes(PARAM_WORLD + '='));
    assert.false(url.includes(PARAM_FIRMWARE + '='));
  });
});

export { runner };
