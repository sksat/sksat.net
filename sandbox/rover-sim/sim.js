/**
 * rover-sim シミュレーションエンジン
 *
 * DOM 非依存の純粋ロジック。app.js (UI) と tests/ の両方から使う。
 *
 * 探査機のハードウェア (形状・センサ・アクチュエータ・運動モデル) は
 * すべてシミュレータ側スクリプトの JS で記述される。エンジン自体は
 * 特定の駆動方式 (差動二輪など) を仮定せず、ユーザ定義の
 * rover.drive(actuators, dt) が返す機体速度 (ツイスト) を積分するだけ。
 *
 * 座標系:
 *   - ワールド座標: 原点はマップ左下、x 右向き・y 上向き [m]
 *   - 機体座標: x 前方・y 左 [m]、heading はワールド x 軸からの CCW 角 [rad]
 */

const DEFAULT_TEMPERATURE = 20;
const DEFAULT_GROUND_COLOR = '#888888';
const MAX_LOGS = 300;

/**
 * 機体速度 (ツイスト) を一定として dt だけ剛体運動を積分する (SE(2) の厳密解)。
 * @param {{x:number, y:number, heading:number}} pose
 * @param {{vx:number, vy:number, omega:number}} twist
 *        vx: 前方速度 [m/s], vy: 機体左向き速度 [m/s], omega: CCW 角速度 [rad/s]
 */
export function stepTwist(pose, twist, dt) {
  const vx = +twist.vx || 0;
  const vy = +twist.vy || 0;
  const omega = +twist.omega || 0;
  const { x, y, heading } = pose;

  let dxb;
  let dyb;
  const th = omega * dt;
  if (Math.abs(omega) < 1e-9) {
    dxb = vx * dt;
    dyb = vy * dt;
  } else {
    // 機体フレームでの変位 (指数写像)
    const s = Math.sin(th);
    const c = Math.cos(th);
    dxb = (vx * s - vy * (1 - c)) / omega;
    dyb = (vx * (1 - c) + vy * s) / omega;
  }

  const ch = Math.cos(heading);
  const sh = Math.sin(heading);
  return {
    x: x + dxb * ch - dyb * sh,
    y: y + dxb * sh + dyb * ch,
    heading: heading + th,
  };
}

/**
 * 差動二輪の運動学ヘルパ。シミュレータ側スクリプトの drive() の参考実装であり、
 * エンジン内部では使わない。
 */
export function stepDiffDrive(pose, vLeft, vRight, tread, dt) {
  return stepTwist(
    pose,
    { vx: (vLeft + vRight) / 2, vy: 0, omega: (vRight - vLeft) / tread },
    dt
  );
}

/** 機体座標 (lx: 前方, ly: 左) をワールド座標へ変換する */
export function localToWorld(pose, lx, ly) {
  const c = Math.cos(pose.heading);
  const s = Math.sin(pose.heading);
  return {
    x: pose.x + lx * c - ly * s,
    y: pose.y + lx * s + ly * c,
  };
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** '#rgb' / '#rrggbb' / {r,g,b} を {r,g,b} に。パース不能なら null */
export function parseColor(c) {
  if (c && typeof c === 'object' && 'r' in c && 'g' in c && 'b' in c) {
    return { r: +c.r || 0, g: +c.g || 0, b: +c.b || 0 };
  }
  if (typeof c !== 'string') return null;
  const s = c.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) {
    const h = m[1];
    return {
      r: parseInt(h[0] + h[0], 16),
      g: parseInt(h[1] + h[1], 16),
      b: parseInt(h[2] + h[2], 16),
    };
  }
  m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) {
    const h = m[1];
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }
  return null;
}

/** {r,g,b} → '#rrggbb' */
export function toHex(color) {
  const h = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return `#${h(color.r)}${h(color.g)}${h(color.b)}`;
}

/** {r,g,b} → 明度 0..1 (輝度近似) */
export function brightness(color) {
  return (0.299 * color.r + 0.587 * color.g + 0.114 * color.b) / 255;
}

/**
 * map.ground() の返り値 (色文字列 or {color, temperature}) をセンサ値に正規化する。
 * @returns {{color:{r,g,b}, hex:string, brightness:number, temperature:number}}
 */
export function normalizeGround(raw) {
  let colorSpec = raw;
  let temperature = DEFAULT_TEMPERATURE;
  if (raw && typeof raw === 'object' && !('r' in raw)) {
    colorSpec = raw.color;
    if (Number.isFinite(+raw.temperature)) temperature = +raw.temperature;
  }
  const color = parseColor(colorSpec) || parseColor(DEFAULT_GROUND_COLOR);
  return { color, hex: toHex(color), brightness: brightness(color), temperature };
}

/** ワールド座標 (x, y) の地面パラメータを読む。マップ外は黒 + outside フラグ */
export function sampleGround(map, x, y) {
  if (x < 0 || x > map.width || y < 0 || y > map.height) {
    return {
      color: { r: 0, g: 0, b: 0 },
      hex: '#000000',
      brightness: 0,
      temperature: DEFAULT_TEMPERATURE,
      outside: true,
    };
  }
  return normalizeGround(map.ground(x, y));
}

function evalScript(source, returnExpr, label) {
  let factory;
  try {
    factory = new Function(`"use strict";\n${source}\n;return (${returnExpr});`);
  } catch (e) {
    throw new Error(`${label}の構文エラー: ${e.message}`);
  }
  try {
    return factory();
  } catch (e) {
    throw new Error(`${label}の実行エラー: ${e.message}`);
  }
}

/**
 * シミュレータ側スクリプト (const map / const rover を定義する JS) を評価・検証し、
 * 正規化されたワールド定義を返す。
 */
export function compileWorld(source) {
  const defs = evalScript(
    source,
    `{
      map: typeof map !== "undefined" ? map : undefined,
      rover: typeof rover !== "undefined" ? rover : undefined,
    }`,
    'シミュレータ記述'
  );

  const map = defs.map;
  if (!map || typeof map !== 'object') {
    throw new Error('map が定義されていません (const map = { ... } を書いてください)');
  }
  const width = +map.width;
  const height = +map.height;
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error('map.width / map.height は正の数 [m] で指定してください');
  }
  if (typeof map.ground !== 'function') {
    throw new Error('map.ground(x, y) 関数を定義してください');
  }

  const rover = defs.rover;
  if (!rover || typeof rover !== 'object') {
    throw new Error('rover が定義されていません (const rover = { ... } を書いてください)');
  }
  if (typeof rover.drive !== 'function') {
    throw new Error(
      'rover.drive(actuators, dt) 関数を定義してください (アクチュエータ指令から機体速度 {vx, vy, omega} を返す運動モデル)'
    );
  }

  const start = rover.start || {};
  const body = rover.body || {};

  const actuators = [];
  const actuatorIds = new Set();
  for (const a of rover.actuators || []) {
    const id = String(a.id ?? '');
    if (!id) throw new Error('アクチュエータには id が必要です');
    if (actuatorIds.has(id)) throw new Error(`アクチュエータ id が重複しています: ${id}`);
    actuatorIds.add(id);
    actuators.push({
      id,
      min: Number.isFinite(+a.min) ? +a.min : -Infinity,
      max: Number.isFinite(+a.max) ? +a.max : Infinity,
      initial: Number.isFinite(+a.initial) ? +a.initial : 0,
    });
  }

  const sensors = [];
  const sensorIds = new Set();
  for (const s of rover.sensors || []) {
    const id = String(s.id ?? '');
    if (!id) throw new Error('センサには id が必要です');
    if (sensorIds.has(id)) throw new Error(`センサ id が重複しています: ${id}`);
    sensorIds.add(id);
    sensors.push({
      id,
      type: s.type || 'ground',
      x: Number.isFinite(+s.x) ? +s.x : 0,
      y: Number.isFinite(+s.y) ? +s.y : 0,
      read: typeof s.read === 'function' ? s.read : null,
    });
  }

  // 見た目の装飾 (タイヤなど)。機体座標系の矩形か円。
  const parts = [];
  for (const p of rover.parts || []) {
    if (!p || (p.shape !== 'rect' && p.shape !== 'circle')) continue;
    parts.push({
      shape: p.shape,
      x: +p.x || 0,
      y: +p.y || 0,
      w: +p.w > 0 ? +p.w : 0.02,
      h: +p.h > 0 ? +p.h : 0.02,
      r: +p.r > 0 ? +p.r : 0.01,
      color: typeof p.color === 'string' ? p.color : '#15181e',
    });
  }

  return {
    map: { width, height, ground: map.ground },
    rover: {
      start: {
        x: Number.isFinite(+start.x) ? +start.x : width / 2,
        y: Number.isFinite(+start.y) ? +start.y : height / 2,
        heading: Number.isFinite(+start.heading) ? +start.heading : 0,
      },
      body: {
        length: +body.length > 0 ? +body.length : 0.22,
        width: +body.width > 0 ? +body.width : 0.16,
        color: typeof body.color === 'string' ? body.color : '#e0e0e0',
      },
      drive: rover.drive,
      actuators,
      sensors,
      parts,
    },
  };
}

/**
 * 探査機内部スクリプト (function loop(rover, dt) {...} を定義する JS) を評価・検証する。
 * @returns {{setup: Function|null, loop: Function}}
 */
export function compileFirmware(source) {
  const fw = evalScript(
    source,
    `{
      setup: typeof setup === "function" ? setup : null,
      loop: typeof loop === "function" ? loop : null,
    }`,
    'ファームウェア'
  );
  if (!fw.loop) {
    throw new Error('ファームウェアには loop(rover, dt) 関数が必要です');
  }
  return fw;
}

function formatLogValue(v) {
  if (typeof v === 'object' && v !== null) {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/**
 * ワールド定義 + ファームウェアを組み合わせたシミュレーション本体。
 * step(dt) を固定刻みで呼ぶ。ファームウェアや drive の例外は error に捕捉され停止する。
 */
export class Simulation {
  constructor(world, firmware) {
    this.world = world;
    this.firmware = firmware;
    this.reset();
  }

  reset() {
    this.pose = { ...this.world.rover.start };
    this.commands = {};
    for (const a of this.world.rover.actuators) this.commands[a.id] = a.initial;
    this.twist = { vx: 0, vy: 0, omega: 0 };
    this.time = 0;
    this.logs = [];
    this.memory = {};
    // ファームウェアが明示的に読んだセンサ値の記録 (テレメトリ表示用)
    this.sensorReadings = {};
    // ファームウェアが rover.telemetry(name, value) で送った任意の値
    this.telemetry = {};
    this.error = null;
    this._booted = false;
    this._api = this._makeApi();
  }

  _log(message) {
    this.logs.push({ time: this.time, message });
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS);
  }

  /** ファームウェアに渡す探査機 API (センサ・アクチュエータの唯一の窓口) */
  _makeApi() {
    const sim = this;
    return {
      get time() {
        return sim.time;
      },
      actuators: this.world.rover.actuators.map((a) => a.id),
      sensors: this.world.rover.sensors.map((s) => s.id),
      memory: this.memory,
      set(id, value) {
        const def = sim.world.rover.actuators.find((a) => a.id === id);
        if (!def) throw new Error(`アクチュエータが見つかりません: ${id}`);
        sim.commands[id] = clamp(+value || 0, def.min, def.max);
      },
      get(id) {
        if (!(id in sim.commands)) throw new Error(`アクチュエータが見つかりません: ${id}`);
        return sim.commands[id];
      },
      sensor(id) {
        const value = sim.readSensor(id);
        sim.sensorReadings[id] = { time: sim.time, value };
        return value;
      },
      telemetry(name, value) {
        const key = String(name);
        // 暴走対策: 上限を超えたら新しいキーを受け付けない (既存キーの更新は可)
        if (!(key in sim.telemetry) && Object.keys(sim.telemetry).length >= 100) return;
        sim.telemetry[key] = { time: sim.time, value };
      },
      log(...args) {
        sim._log(args.map(formatLogValue).join(' '));
      },
    };
  }

  readSensor(id) {
    const def = this.world.rover.sensors.find((s) => s.id === id);
    if (!def) throw new Error(`センサが見つかりません: ${id}`);
    const p = localToWorld(this.pose, def.x, def.y);
    if (def.read) {
      // カスタムセンサ: ワールド情報を渡してユーザ定義の read() に任せる
      return def.read({
        x: p.x,
        y: p.y,
        heading: this.pose.heading,
        time: this.time,
        ground: (gx, gy) => sampleGround(this.world.map, gx, gy),
      });
    }
    return sampleGround(this.world.map, p.x, p.y);
  }

  step(dt) {
    if (this.error) return;
    try {
      if (!this._booted) {
        this._booted = true;
        if (this.firmware.setup) this.firmware.setup(this._api);
      }
      this.firmware.loop(this._api, dt);

      // ユーザ定義の運動モデルでアクチュエータ指令 → 機体速度
      const twist = this.world.rover.drive({ ...this.commands }, dt) || {};
      this.twist = {
        vx: +twist.vx || 0,
        vy: +twist.vy || 0,
        omega: +twist.omega || 0,
      };
    } catch (e) {
      this.error = e instanceof Error ? e : new Error(String(e));
      this._log(`ERROR: ${this.error.message}`);
      return;
    }

    this.pose = stepTwist(this.pose, this.twist, dt);
    this.pose.x = clamp(this.pose.x, 0, this.world.map.width);
    this.pose.y = clamp(this.pose.y, 0, this.world.map.height);
    this.time += dt;
  }
}
