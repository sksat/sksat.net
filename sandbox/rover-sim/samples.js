/**
 * rover-sim サンプルスクリプト集
 *
 * 各サンプルは「シミュレータ側 (マップ + 探査機ハードウェア)」と
 * 「探査機内部 (ファームウェア)」のスクリプトのペア。
 * IDE のサンプル選択から読み込む。
 */

const BASIC_WORLD = `// ================================================
// シミュレータ側の記述: マップと探査機ハードウェア
// ================================================
// 単位: メートル / 秒 / ラジアン。原点はマップ左下、y は上向き。

// ---- マップ定義 ----
// ground(x, y) が地面のパラメータ (色・温度) を座標ごとに返す。
// 色だけなら '#rrggbb' 文字列を返してもよい。
const map = {
  width: 4.0,
  height: 3.0,

  ground(x, y) {
    // 中央を通る十字線
    const onCross = Math.abs(x - 2.0) < 0.02 || Math.abs(y - 1.5) < 0.02;

    // 右上に熱源がある (温度表示モードやセンサで見える)
    const dh = Math.hypot(x - 3.4, y - 2.5);
    const temperature = 20 + 30 * Math.exp(-(dh * dh) / (2 * 0.35 * 0.35));

    return {
      color: onCross ? '#b5a97e' : '#d8cfa8',
      temperature: temperature,
    };
  },
};

// ---- 探査機ハードウェア定義 ----
// 形状・センサ・アクチュエータ・運動モデルをすべてここで記述する。
const rover = {
  start: { x: 1.7, y: 1.5, heading: 0 },  // 初期位置・向き

  body: { length: 0.22, width: 0.16, color: '#e8e8e8' },

  // 見た目の装飾 (機体座標系: x 前方, y 左)。ここでは左右のタイヤ。
  parts: [
    { shape: 'rect', x: 0, y:  0.075, w: 0.07, h: 0.03, color: '#15181e' },
    { shape: 'rect', x: 0, y: -0.075, w: 0.07, h: 0.03, color: '#15181e' },
  ],

  // アクチュエータ: ファームウェアから rover.set(id, value) で指令する
  actuators: [
    { id: 'wheel-left',  min: -0.5, max: 0.5 },   // 左タイヤ速度 [m/s]
    { id: 'wheel-right', min: -0.5, max: 0.5 },   // 右タイヤ速度 [m/s]
  ],

  // 運動モデル: アクチュエータ指令 → 機体速度 { vx: 前方, vy: 左, omega: CCW }
  // ここを書き換えれば差動二輪以外 (オムニホイール・スラスタ等) も作れる。
  drive(act, dt) {
    const tread = 0.14;  // 左右タイヤ間隔 [m]
    return {
      vx: (act['wheel-left'] + act['wheel-right']) / 2,
      vy: 0,
      omega: (act['wheel-right'] - act['wheel-left']) / tread,
    };
  },

  // センサ: type 'ground' は取り付け位置の真下の地面を読む。
  // read(ctx) 関数を持たせれば任意のカスタムセンサも作れる。
  sensors: [
    { id: 'ground', type: 'ground', x: 0.09, y: 0 },
  ],
};
`;

const BASIC_FIRMWARE = `// ================================================
// 探査機内部の記述: ファームウェア
// ================================================
// loop(rover, dt) が毎ステップ (1/60 s) 呼ばれる。
//
// rover API:
//   rover.set(id, value)          アクチュエータへ指令 (min/max でクランプ)
//   rover.get(id)                 現在の指令値
//   rover.actuators               アクチュエータ id 一覧
//   rover.sensor(id)              センサ値 { hex, color, brightness, temperature }
//                                 読んだ値はテレメトリパネルに表示される
//   rover.sensors                 センサ id 一覧
//   rover.telemetry(name, value)  任意の値をテレメトリパネルに表示する
//   rover.time                    起動からの経過時間 [s]
//   rover.memory                  自由に使える永続オブジェクト
//   rover.log(...)                コンソール出力

function setup(rover) {
  rover.log('rover boot');
  rover.log('actuators:', rover.actuators.join(', '));
}

// デモ: 2 秒ごとに前進・後進を繰り返す
function loop(rover, dt) {
  const phase = Math.floor(rover.time / 2.0) % 2;
  const v = phase === 0 ? 0.3 : -0.3;  // 前進 / 後進
  rover.set('wheel-left', v);
  rover.set('wheel-right', v);

  // センサを読む / 任意の値を送るとテレメトリパネルに出る
  rover.sensor('ground');
  rover.telemetry('mode', phase === 0 ? 'forward' : 'backward');
}
`;

const LINETRACE_WORLD = `// ================================================
// ライントレース環境: 楕円コースと左右ラインセンサ付き探査機
// ================================================
const map = {
  width: 4.0,
  height: 3.0,

  ground(x, y) {
    // 楕円形のライン
    const cx = 2.0, cy = 1.5;    // 中心
    const rx = 1.4, ry = 0.9;    // 半径
    const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
    const onLine = Math.abs(d - 1.0) < 0.035;
    return onLine ? '#222222' : '#d8cfa8';
  },
};

const rover = {
  start: { x: 2.0, y: 0.6, heading: 0 },  // ラインの真上からスタート

  body: { length: 0.22, width: 0.16, color: '#e8e8e8' },

  parts: [
    { shape: 'rect', x: 0, y:  0.075, w: 0.07, h: 0.03, color: '#15181e' },
    { shape: 'rect', x: 0, y: -0.075, w: 0.07, h: 0.03, color: '#15181e' },
  ],

  actuators: [
    { id: 'wheel-left',  min: -0.5, max: 0.5 },
    { id: 'wheel-right', min: -0.5, max: 0.5 },
  ],

  drive(act, dt) {
    const tread = 0.14;
    return {
      vx: (act['wheel-left'] + act['wheel-right']) / 2,
      vy: 0,
      omega: (act['wheel-right'] - act['wheel-left']) / tread,
    };
  },

  // ラインを挟むように前方左右へセンサを配置
  sensors: [
    { id: 'line-left',  type: 'ground', x: 0.09, y:  0.045 },
    { id: 'line-right', type: 'ground', x: 0.09, y: -0.045 },
  ],
};
`;

const LINETRACE_FIRMWARE = `// ================================================
// ライントレース環境用ファームウェア (制御は未実装)
// ================================================
// 探査機の前方左右に line-left / line-right センサが付いている。
// .brightness (0..1) でラインの暗さが読めるので、
// ライントレース制御を書いてみてください。

function setup(rover) {
  rover.log('boot: sensors =', rover.sensors.join(', '));
}

function loop(rover, dt) {
  // センサを読む (読んだ値はテレメトリパネルに表示される)
  const l = rover.sensor('line-left');
  const r = rover.sensor('line-right');

  // とりあえずゆっくり前進するだけ
  rover.set('wheel-left', 0.2);
  rover.set('wheel-right', 0.2);
}
`;

export const SAMPLES = [
  { id: 'basic', name: '基本 (前進・後進)', world: BASIC_WORLD, firmware: BASIC_FIRMWARE },
  { id: 'linetrace', name: 'ライントレース', world: LINETRACE_WORLD, firmware: LINETRACE_FIRMWARE },
];

// デフォルトサンプル (テスト・初期表示用)
export const SAMPLE_WORLD = BASIC_WORLD;
export const SAMPLE_FIRMWARE = BASIC_FIRMWARE;
