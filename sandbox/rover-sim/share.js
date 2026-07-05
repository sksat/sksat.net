/**
 * URL 共有コーデック
 *
 * 単純な設定 (speed, view) は素のクエリパラメータ、
 * シミュレータ側コードと探査機コードはそれぞれ別パラメータに
 * base64url で載せる。DOM 非依存 (tests/ からも使う)。
 *
 * コードパラメータの形式:
 *   "1-<base64url(deflate-raw(utf8(code)))>"  圧縮版 (通常。URL を短くするため)
 *   "0-<base64url(utf8(code))>"               無圧縮版 (手書き・非対応環境用)
 */

export const PARAM_WORLD = 'world';
export const PARAM_FIRMWARE = 'firmware';
export const PARAM_SAMPLE = 'sample';
export const PARAM_SPEED = 'speed';
export const PARAM_VIEW = 'view';

const PREFIX_DEFLATE = '1-';
const PREFIX_PLAIN = '0-';

function bytesToBase64url(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBytes(s) {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('base64url 以外の文字が含まれています');
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 2 ? '==' : b64.length % 4 === 3 ? '=' : '';
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function pipeThrough(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** コード文字列をクエリパラメータ用の base64url ペイロードへ */
export async function encodeText(text) {
  const bytes = new TextEncoder().encode(String(text));
  if (typeof CompressionStream === 'function') {
    const compressed = await pipeThrough(bytes, new CompressionStream('deflate-raw'));
    return PREFIX_DEFLATE + bytesToBase64url(compressed);
  }
  return PREFIX_PLAIN + bytesToBase64url(bytes);
}

/** encodeText の逆変換。壊れたペイロードは Error を投げる */
export async function decodeText(payload) {
  try {
    let bytes;
    if (payload.startsWith(PREFIX_DEFLATE)) {
      const compressed = base64urlToBytes(payload.slice(PREFIX_DEFLATE.length));
      bytes = await pipeThrough(compressed, new DecompressionStream('deflate-raw'));
    } else if (payload.startsWith(PREFIX_PLAIN)) {
      bytes = base64urlToBytes(payload.slice(PREFIX_PLAIN.length));
    } else {
      throw new Error('未知のフォーマットです');
    }
    return new TextDecoder().decode(bytes);
  } catch (e) {
    throw new Error(`共有データを読み取れませんでした (${e.message})`);
  }
}

/**
 * 既存のクエリ・ハッシュを除いた URL に共有パラメータを付ける。
 * params の undefined / null / 空文字は省く。
 */
export function buildShareUrl(href, params) {
  const base = href.split(/[?#]/)[0];
  const parts = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length > 0 ? `${base}?${parts.join('&')}` : base;
}
