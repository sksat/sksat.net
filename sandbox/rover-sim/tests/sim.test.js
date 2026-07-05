/**
 * rover-sim エンジンのテスト
 */
import { createTestRunner, assert } from './test-runner.js';
import {
  stepTwist,
  stepDiffDrive,
  localToWorld,
  parseColor,
  brightness,
  normalizeGround,
  sampleGround,
  compileWorld,
  compileFirmware,
  roverCollides,
  Simulation,
} from '../sim.js';
import { SAMPLES, SAMPLE_WORLD, SAMPLE_FIRMWARE } from '../samples.js';

const { runner, describe, it } = createTestRunner();

const DT = 1 / 60;

function makeSim(worldSrc, firmwareSrc) {
  return new Simulation(compileWorld(worldSrc), compileFirmware(firmwareSrc));
}

// 差動二輪をユーザスクリプト側で記述した最小ワールド
const MINI_WORLD = `
const map = { width: 2, height: 2, ground(x, y) { return '#ffffff'; } };
const rover = {
  actuators: [
    { id: 'wheel-left', min: -0.5, max: 0.5 },
    { id: 'wheel-right', min: -0.5, max: 0.5 },
  ],
  drive(act, dt) {
    return {
      vx: (act['wheel-left'] + act['wheel-right']) / 2,
      vy: 0,
      omega: (act['wheel-right'] - act['wheel-left']) / 0.2,
    };
  },
  sensors: [],
};
`;

describe('stepTwist (SE(2) 剛体運動の積分)', () => {
  it('前方速度のみなら直進する', () => {
    const p = stepTwist({ x: 0, y: 0, heading: 0 }, { vx: 0.5, vy: 0, omega: 0 }, 2);
    assert.approximately(p.x, 1, 1e-12);
    assert.approximately(p.y, 0, 1e-12);
    assert.approximately(p.heading, 0, 1e-12);
  });

  it('横方向速度 (vy: 機体左) は heading 0 でワールド +y に進む', () => {
    const p = stepTwist({ x: 0, y: 0, heading: 0 }, { vx: 0, vy: 0.5, omega: 0 }, 2);
    assert.approximately(p.x, 0, 1e-12);
    assert.approximately(p.y, 1, 1e-12);
  });

  it('heading π/2 では前方がワールド +y になる', () => {
    const p = stepTwist({ x: 0, y: 0, heading: Math.PI / 2 }, { vx: 0.5, vy: 0, omega: 0 }, 2);
    assert.approximately(p.x, 0, 1e-12);
    assert.approximately(p.y, 1, 1e-12);
  });

  it('omega のみならその場旋回する', () => {
    const p = stepTwist({ x: 1, y: 2, heading: 0 }, { vx: 0, vy: 0, omega: 1 }, Math.PI / 2);
    assert.approximately(p.heading, Math.PI / 2, 1e-12);
    assert.approximately(p.x, 1, 1e-12);
    assert.approximately(p.y, 2, 1e-12);
  });

  it('vx + omega は円弧を描き、一周で元の位置に戻る', () => {
    const p = stepTwist({ x: 0, y: 0, heading: 0 }, { vx: 0.1, vy: 0, omega: 1 }, 2 * Math.PI);
    assert.approximately(p.x, 0, 1e-9);
    assert.approximately(p.y, 0, 1e-9);
    assert.approximately(p.heading, 2 * Math.PI, 1e-9);
  });

  it('半周で旋回中心の反対側に到達する (R = vx/omega)', () => {
    const p = stepTwist({ x: 0, y: 0, heading: 0 }, { vx: 0.1, vy: 0, omega: 1 }, Math.PI);
    assert.approximately(p.x, 0, 1e-9);
    assert.approximately(p.y, 0.2, 1e-9);
  });
});

describe('stepDiffDrive (差動二輪ヘルパ)', () => {
  it('左右同速なら直進する', () => {
    const p = stepDiffDrive({ x: 0, y: 0, heading: 0 }, 0.5, 0.5, 0.2, 2);
    assert.approximately(p.x, 1, 1e-12);
    assert.approximately(p.y, 0, 1e-12);
    assert.approximately(p.heading, 0, 1e-12);
  });

  it('左右逆速ならその場旋回する', () => {
    // ω = (vr - vl) / tread = 0.2 / 0.2 = 1 rad/s
    const p = stepDiffDrive({ x: 0, y: 0, heading: 0 }, -0.1, 0.1, 0.2, Math.PI / 2);
    assert.approximately(p.heading, Math.PI / 2, 1e-12);
    assert.approximately(p.x, 0, 1e-12);
    assert.approximately(p.y, 0, 1e-12);
  });

  it('片輪のみ駆動で円弧を描き、一周すると元の位置に戻る', () => {
    // vl=0, vr=0.2, tread=0.2 → ω=1 rad/s, R=0.1 m
    const p = stepDiffDrive({ x: 0, y: 0, heading: 0 }, 0, 0.2, 0.2, 2 * Math.PI);
    assert.approximately(p.x, 0, 1e-9);
    assert.approximately(p.y, 0, 1e-9);
    assert.approximately(p.heading, 2 * Math.PI, 1e-9);
  });
});

describe('localToWorld (機体座標→ワールド座標)', () => {
  it('heading 0 では平行移動になる', () => {
    const p = localToWorld({ x: 2, y: 3, heading: 0 }, 0.5, 0.25);
    assert.approximately(p.x, 2.5, 1e-12);
    assert.approximately(p.y, 3.25, 1e-12);
  });

  it('heading π/2 で前方(+x_local)がワールド +y を向く', () => {
    const p = localToWorld({ x: 2, y: 3, heading: Math.PI / 2 }, 1, 0);
    assert.approximately(p.x, 2, 1e-12);
    assert.approximately(p.y, 4, 1e-12);
  });

  it('heading π/2 で機体左(+y_local)がワールド -x を向く', () => {
    const p = localToWorld({ x: 2, y: 3, heading: Math.PI / 2 }, 0, 1);
    assert.approximately(p.x, 1, 1e-12);
    assert.approximately(p.y, 3, 1e-12);
  });
});

describe('parseColor / brightness', () => {
  it('#rgb 短縮形をパースできる', () => {
    assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255 });
  });

  it('#rrggbb をパースできる', () => {
    assert.deepEqual(parseColor('#102030'), { r: 16, g: 32, b: 48 });
  });

  it('{r,g,b} オブジェクトはそのまま通る', () => {
    assert.deepEqual(parseColor({ r: 1, g: 2, b: 3 }), { r: 1, g: 2, b: 3 });
  });

  it('パースできない文字列は null を返す', () => {
    assert.equal(parseColor('oops'), null);
  });

  it('白の明度は 1、黒は 0', () => {
    assert.approximately(brightness({ r: 255, g: 255, b: 255 }), 1, 1e-9);
    assert.approximately(brightness({ r: 0, g: 0, b: 0 }), 0, 1e-9);
  });
});

describe('normalizeGround / sampleGround (地面パラメータ)', () => {
  it('色文字列だけ返す ground はデフォルト温度 20℃ になる', () => {
    const g = normalizeGround('#ffffff');
    assert.equal(g.hex, '#ffffff');
    assert.equal(g.temperature, 20);
    assert.approximately(g.brightness, 1, 1e-9);
  });

  it('{color, temperature} 形式で温度を指定できる', () => {
    const g = normalizeGround({ color: '#000000', temperature: 42 });
    assert.equal(g.hex, '#000000');
    assert.equal(g.temperature, 42);
  });

  it('マップ内の座標では ground の返り値が反映される', () => {
    const map = { width: 2, height: 2, ground: (x) => (x < 1 ? '#000000' : '#ffffff') };
    assert.equal(sampleGround(map, 0.5, 0.5).hex, '#000000');
    assert.equal(sampleGround(map, 1.5, 0.5).hex, '#ffffff');
    assert.falsy(sampleGround(map, 0.5, 0.5).outside);
  });

  it('マップ外は outside フラグが立ち黒になる', () => {
    const map = { width: 2, height: 2, ground: () => '#ffffff' };
    const g = sampleGround(map, -0.1, 0.5);
    assert.true(g.outside);
    assert.equal(g.hex, '#000000');
  });
});

describe('compileWorld (シミュレータ側スクリプト)', () => {
  it('map と rover を定義したスクリプトをコンパイルできる', () => {
    const world = compileWorld(MINI_WORLD);
    assert.equal(world.map.width, 2);
    assert.equal(typeof world.map.ground, 'function');
    assert.equal(typeof world.rover.drive, 'function');
    assert.equal(world.rover.actuators.length, 2);
  });

  it('start 省略時はマップ中央・heading 0 になる', () => {
    const world = compileWorld(MINI_WORLD);
    assert.approximately(world.rover.start.x, 1, 1e-12);
    assert.approximately(world.rover.start.y, 1, 1e-12);
    assert.equal(world.rover.start.heading, 0);
  });

  it('アクチュエータの min/max 省略時は無制限になる', () => {
    const world = compileWorld(`
      const map = { width: 1, height: 1, ground() { return '#fff'; } };
      const rover = { actuators: [{ id: 'a' }], drive() { return { vx: 0, vy: 0, omega: 0 }; } };
    `);
    assert.equal(world.rover.actuators[0].min, -Infinity);
    assert.equal(world.rover.actuators[0].max, Infinity);
  });

  it('map 未定義はエラー', () => {
    assert.throws(() => compileWorld('const x = 1;'));
  });

  it('rover 未定義はエラー', () => {
    assert.throws(() => compileWorld('const map = { width: 1, height: 1, ground() { return "#fff"; } };'));
  });

  it('map.ground が関数でなければエラー', () => {
    assert.throws(() => compileWorld('const map = { width: 1, height: 1 }; const rover = { drive() {} };'));
  });

  it('rover.drive が関数でなければエラー', () => {
    assert.throws(() =>
      compileWorld('const map = { width: 1, height: 1, ground() { return "#fff"; } }; const rover = {};')
    );
  });

  it('構文エラーを検出できる', () => {
    assert.throws(() => compileWorld('const map = {'));
  });

  it('センサ id の重複はエラー', () => {
    assert.throws(() =>
      compileWorld(`
        const map = { width: 1, height: 1, ground() { return '#fff'; } };
        const rover = { drive() { return {}; }, sensors: [{ id: 'a' }, { id: 'a' }] };
      `)
    );
  });

  it('アクチュエータ id の重複はエラー', () => {
    assert.throws(() =>
      compileWorld(`
        const map = { width: 1, height: 1, ground() { return '#fff'; } };
        const rover = { drive() { return {}; }, actuators: [{ id: 'a' }, { id: 'a' }] };
      `)
    );
  });
});

describe('roverCollides (形状を考慮した衝突判定)', () => {
  // body デフォルト: length 0.22, width 0.16
  const world = compileWorld(MINI_WORLD); // 2x2, 壁なし

  it('マップ中央では衝突しない', () => {
    assert.false(roverCollides(world, { x: 1, y: 1, heading: 0 }));
  });

  it('中心がマップ内でも車体がはみ出せば衝突', () => {
    // 前端 = x + 0.11 > 2
    assert.true(roverCollides(world, { x: 1.95, y: 1, heading: 0 }));
    assert.false(roverCollides(world, { x: 1.85, y: 1, heading: 0 }));
  });

  it('回転を考慮する (同じ位置でも向きで判定が変わる)', () => {
    // heading 0: 下端 = y - width/2 = 0.06 - 0.08 < 0 → 衝突
    assert.true(roverCollides(world, { x: 1, y: 0.06, heading: 0 }));
    // 十分内側なら OK
    assert.false(roverCollides(world, { x: 1, y: 0.12, heading: 0 }));
    // 同じ y=0.12 でも縦向き (length/2 = 0.11 が下を向く) だと衝突
    assert.true(roverCollides(world, { x: 1, y: 0.1, heading: Math.PI / 2 }));
  });

  it('map.wall(x, y) で定義した壁と衝突する', () => {
    const w = compileWorld(`
      const map = { width: 2, height: 2, ground() { return '#fff'; }, wall(x, y) { return x > 1.5; } };
      const rover = { drive() { return {}; } };
    `);
    assert.false(roverCollides(w, { x: 1.3, y: 1, heading: 0 })); // 前端 1.41 < 1.5
    assert.true(roverCollides(w, { x: 1.45, y: 1, heading: 0 })); // 前端 1.56 > 1.5
  });
});

describe('compileWorld (壁)', () => {
  it('map.wall は省略可能', () => {
    const world = compileWorld(MINI_WORLD);
    assert.equal(world.map.wall, null);
  });

  it('map.wall が関数ならそのまま使われる', () => {
    const world = compileWorld(`
      const map = { width: 2, height: 2, ground() { return '#fff'; }, wall(x, y) { return x > 1; } };
      const rover = { drive() { return {}; } };
    `);
    assert.equal(typeof world.map.wall, 'function');
  });

  it('map.wall が関数以外ならエラー', () => {
    assert.throws(() =>
      compileWorld(`
        const map = { width: 2, height: 2, ground() { return '#fff'; }, wall: true };
        const rover = { drive() { return {}; } };
      `)
    );
  });

  it('壁の上を読むと wall フラグ付きのセンサ値になる', () => {
    const world = compileWorld(`
      const map = { width: 2, height: 2, ground() { return '#ffffff'; }, wall(x, y) { return x > 1.5; } };
      const rover = { drive() { return {}; } };
    `);
    assert.true(sampleGround(world.map, 1.8, 1).wall === true);
    assert.falsy(sampleGround(world.map, 0.5, 1).wall);
  });
});

describe('compileFirmware (探査機内部スクリプト)', () => {
  it('loop を定義したスクリプトをコンパイルできる', () => {
    const fw = compileFirmware('function loop(rover, dt) {}');
    assert.equal(typeof fw.loop, 'function');
    assert.equal(fw.setup, null);
  });

  it('setup も拾える', () => {
    const fw = compileFirmware('function setup(r) {} function loop(r, dt) {}');
    assert.equal(typeof fw.setup, 'function');
  });

  it('loop がなければエラー', () => {
    assert.throws(() => compileFirmware('function setup(r) {}'));
  });

  it('構文エラーを検出できる', () => {
    assert.throws(() => compileFirmware('function loop( {'));
  });
});

describe('Simulation (統合)', () => {
  it('rover.set のアクチュエータ指令は min/max でクランプされる', () => {
    const sim = makeSim(
      MINI_WORLD,
      `function loop(rover, dt) { rover.set('wheel-left', 99); rover.set('wheel-right', -99); }`
    );
    sim.step(DT);
    assert.approximately(sim.commands['wheel-left'], 0.5, 1e-12);
    assert.approximately(sim.commands['wheel-right'], -0.5, 1e-12);
  });

  it('存在しないアクチュエータ id への set はファームウェアエラーになる', () => {
    const sim = makeSim(MINI_WORLD, `function loop(rover, dt) { rover.set('typo', 1); }`);
    sim.step(DT);
    assert.truthy(sim.error);
  });

  it('rover.actuators で id 一覧が見える', () => {
    const sim = makeSim(
      MINI_WORLD,
      `function setup(rover) { rover.log(rover.actuators.join(',')); }
       function loop(rover, dt) {}`
    );
    sim.step(DT);
    assert.true(sim.logs[0].message.includes('wheel-left,wheel-right'));
  });

  it('drive の運動モデルに従って動く (差動二輪をユーザ定義した場合)', () => {
    const sim = makeSim(
      MINI_WORLD,
      `function loop(rover, dt) { rover.set('wheel-left', 0.3); rover.set('wheel-right', 0.3); }`
    );
    for (let i = 0; i < 60; i++) sim.step(DT); // 1 s
    assert.approximately(sim.pose.x, 1.3, 1e-6);
    assert.approximately(sim.pose.y, 1, 1e-6);
  });

  it('二輪以外の運動モデルも記述できる (横移動するオムニ駆動)', () => {
    const sim = makeSim(
      `
      const map = { width: 2, height: 2, ground() { return '#fff'; } };
      const rover = {
        actuators: [{ id: 'strafe' }],
        drive(act, dt) { return { vx: 0, vy: act['strafe'], omega: 0 }; },
      };
      `,
      `function loop(rover, dt) { rover.set('strafe', 0.2); }`
    );
    for (let i = 0; i < 60; i++) sim.step(DT); // 1 s: 機体左 = ワールド +y
    assert.approximately(sim.pose.x, 1, 1e-6);
    assert.approximately(sim.pose.y, 1.2, 1e-6);
  });

  it('マップ境界には形状 (車体前端) がぶつかった位置で止まる', () => {
    const sim = makeSim(
      MINI_WORLD,
      `function loop(rover, dt) { rover.set('wheel-left', 0.5); rover.set('wheel-right', 0.5); }`
    );
    for (let i = 0; i < 600; i++) sim.step(DT); // 10 s → 5 m 相当
    // 車体前端 (中心 + length/2 = 0.11) が右端に接する位置で停止
    assert.approximately(sim.pose.x, 2 - 0.11, 2e-3, '前端がマップ右端に接して止まる');
    assert.true(sim.collided, '接触フラグが立つ');
    assert.equal(sim.error, null);
    assert.false(roverCollides(sim.world, sim.pose), 'めり込まない');
  });

  it('map.wall の壁にも形状がぶつかった位置で止まる', () => {
    const sim = makeSim(
      `
      const map = { width: 4, height: 2, ground() { return '#fff'; }, wall(x, y) { return x > 2.5; } };
      const rover = { start: { x: 1, y: 1, heading: 0 }, drive(act) { return { vx: act['f'] || 0, vy: 0, omega: 0 }; }, actuators: [{ id: 'f' }] };
      `,
      `function loop(rover, dt) { rover.set('f', 0.5); }`
    );
    for (let i = 0; i < 600; i++) sim.step(DT); // 10 s
    assert.approximately(sim.pose.x, 2.5 - 0.11, 2e-3, '前端が壁面に接して止まる');
    assert.equal(sim.error, null);
    assert.false(roverCollides(sim.world, sim.pose));
    // 後進すれば離れられる
    sim.commands['f'] = 0; // 念のためリセット
    const fwBack = compileFirmware(`function loop(rover, dt) { rover.set('f', -0.3); }`);
    sim.firmware = fwBack;
    for (let i = 0; i < 60; i++) sim.step(DT);
    assert.true(sim.pose.x < 2.3, '壁から離れて後進できる');
  });

  it('壁の中でスタートしても警告ログを出して動ける (永久フリーズしない)', () => {
    const sim = makeSim(
      `
      const map = { width: 4, height: 2, ground() { return '#fff'; }, wall(x, y) { return x < 1.5; } };
      const rover = { start: { x: 1, y: 1, heading: 0 }, drive(act) { return { vx: act['f'] || 0, vy: 0, omega: 0 }; }, actuators: [{ id: 'f' }] };
      `,
      `function loop(rover, dt) { rover.set('f', 0.5); }`
    );
    for (let i = 0; i < 300; i++) sim.step(DT); // 5 s → 壁の外へ脱出できる
    assert.equal(sim.error, null);
    assert.true(sim.pose.x > 1.6, `壁から脱出できる (x = ${sim.pose.x})`);
    assert.true(
      sim.logs.some((l) => l.message.includes('警告')),
      '警告ログが出る'
    );
  });

  it('ground センサは機体位置・向きに応じた地面を読む', () => {
    const src = `
      const map = { width: 2, height: 2, ground(x, y) { return x < 1 ? '#000000' : '#ffffff'; } };
      const rover = {
        start: { x: 0.95, y: 1, heading: 0 },
        drive() { return { vx: 0, vy: 0, omega: 0 }; },
        sensors: [{ id: 'front', x: 0.1, y: 0 }],
      };
    `;
    const sim = makeSim(src, 'function loop(r, dt) {}');
    assert.equal(sim.readSensor('front').hex, '#ffffff', '前方センサは境界の先の白を読む');
    sim.pose.heading = Math.PI;
    assert.equal(sim.readSensor('front').hex, '#000000', '反転すると黒側を読む');
  });

  it('ground センサは温度も返す', () => {
    const src = `
      const map = { width: 2, height: 2, ground() { return { color: '#ffffff', temperature: 42 }; } };
      const rover = { drive() { return {}; }, sensors: [{ id: 's' }] };
    `;
    const sim = makeSim(src, 'function loop(r, dt) {}');
    assert.equal(sim.readSensor('s').temperature, 42);
  });

  it('read() を持つカスタムセンサを定義できる', () => {
    const src = `
      const map = { width: 2, height: 2, ground() { return '#fff'; } };
      const rover = {
        drive() { return {}; },
        sensors: [{ id: 'custom', read(ctx) { return { value: ctx.x + 1 }; } }],
      };
    `;
    const sim = makeSim(src, 'function loop(r, dt) {}');
    assert.approximately(sim.readSensor('custom').value, 2, 1e-12); // start x=1 (中央)
  });

  it('存在しないセンサ id は例外', () => {
    const sim = makeSim(MINI_WORLD, 'function loop(r, dt) {}');
    assert.throws(() => sim.readSensor('nope'));
  });

  it('センサ値はファームウェアが明示的に読んだときだけ記録される', () => {
    const src = `
      const map = { width: 2, height: 2, ground() { return '#fff'; } };
      const rover = { drive() { return {}; }, sensors: [{ id: 'a' }, { id: 'b' }] };
    `;
    const sim = makeSim(src, `function loop(rover, dt) { if (rover.time > 0.05) rover.sensor('a'); }`);
    sim.step(DT);
    assert.deepEqual(Object.keys(sim.sensorReadings), [], '読むまでは空');
    for (let i = 0; i < 10; i++) sim.step(DT);
    assert.truthy(sim.sensorReadings['a'], '読んだセンサは記録される');
    assert.equal(sim.sensorReadings['a'].value.hex, '#ffffff');
    assert.true(sim.sensorReadings['a'].time > 0.05, '読んだ時刻が記録される');
    assert.falsy(sim.sensorReadings['b'], '読んでいないセンサは記録されない');
  });

  it('rover.telemetry で任意の値をテレメトリに送れる', () => {
    const sim = makeSim(
      MINI_WORLD,
      `function loop(rover, dt) { rover.telemetry('mode', 'forward'); rover.telemetry('count', 42); }`
    );
    sim.step(DT);
    assert.equal(sim.telemetry['mode'].value, 'forward');
    assert.equal(sim.telemetry['count'].value, 42);
    assert.equal(typeof sim.telemetry['mode'].time, 'number');
  });

  it('rover.memory は loop をまたいで保持される', () => {
    const sim = makeSim(
      MINI_WORLD,
      'function loop(rover, dt) { rover.memory.n = (rover.memory.n || 0) + 1; }'
    );
    sim.step(DT);
    sim.step(DT);
    sim.step(DT);
    assert.equal(sim.memory.n, 3);
  });

  it('setup は最初の step で一度だけ呼ばれ、log が残る', () => {
    const sim = makeSim(
      MINI_WORLD,
      `function setup(rover) { rover.log('boot'); }
       function loop(rover, dt) {}`
    );
    sim.step(DT);
    sim.step(DT);
    const boots = sim.logs.filter((l) => l.message.includes('boot'));
    assert.equal(boots.length, 1);
  });

  it('ファームウェア例外は捕捉され、以後 step しても進まない', () => {
    const sim = makeSim(MINI_WORLD, 'function loop() { throw new Error("bang"); }');
    sim.step(DT);
    assert.truthy(sim.error);
    assert.true(String(sim.error.message).includes('bang'));
    const t = sim.time;
    sim.step(DT);
    assert.equal(sim.time, t, '時間が進まない');
  });

  it('drive の例外も捕捉される', () => {
    const sim = makeSim(
      `
      const map = { width: 2, height: 2, ground() { return '#fff'; } };
      const rover = { drive() { throw new Error('broken drive'); } };
      `,
      'function loop(r, dt) {}'
    );
    sim.step(DT);
    assert.truthy(sim.error);
    assert.true(String(sim.error.message).includes('broken drive'));
  });

  it('reset で時刻・位置・エラーが初期化される', () => {
    const sim = makeSim(
      MINI_WORLD,
      `function loop(r) { r.set('wheel-left', 0.3); r.set('wheel-right', 0.3); }`
    );
    for (let i = 0; i < 60; i++) sim.step(DT);
    sim.reset();
    assert.equal(sim.time, 0);
    assert.approximately(sim.pose.x, 1, 1e-12);
    assert.equal(sim.error, null);
  });
});

describe('サンプルデモ (前進・後進の繰り返し)', () => {
  it('サンプルのシミュレータ記述・ファームウェアがコンパイルできる', () => {
    const world = compileWorld(SAMPLE_WORLD);
    const fw = compileFirmware(SAMPLE_FIRMWARE);
    assert.equal(typeof world.map.ground, 'function');
    assert.equal(typeof fw.loop, 'function');
    assert.true(world.rover.sensors.length >= 1, 'センサが載っている');
    assert.equal(world.rover.actuators.length, 2, '左右モータの 2 アクチュエータ');
    assert.equal(typeof world.rover.drive, 'function', '運動モデルもスクリプト側で定義');
    assert.equal(typeof world.map.wall, 'function', '壁の設置例が入っている');
  });

  it('モータは PWM デューティ比 (-1〜1) で指令する', () => {
    const world = compileWorld(SAMPLE_WORLD);
    const ids = world.rover.actuators.map((a) => a.id);
    assert.deepEqual(ids, ['motor-left', 'motor-right']);
    for (const a of world.rover.actuators) {
      assert.equal(a.min, -1, `${a.id} の min はデューティ比 -1`);
      assert.equal(a.max, 1, `${a.id} の max はデューティ比 +1`);
    }
    // 範囲外の指令はクランプされる
    const sim = new Simulation(
      world,
      compileFirmware(`function loop(rover, dt) { rover.set('motor-left', 5); rover.set('motor-right', -5); }`)
    );
    sim.step(DT);
    assert.equal(sim.commands['motor-left'], 1);
    assert.equal(sim.commands['motor-right'], -1);
  });

  it('モータは一次遅れで応答する (即座に定常速度にならない)', () => {
    const sim = new Simulation(
      compileWorld(SAMPLE_WORLD),
      compileFirmware(`function loop(rover, dt) { rover.set('motor-left', 1); rover.set('motor-right', 1); }`)
    );
    sim.step(DT);
    assert.true(sim.twist.vx > 0, '動き始める');
    assert.true(sim.twist.vx < 0.15, `1 ステップ目は定常速度に達しない (vx = ${sim.twist.vx})`);
    for (let i = 0; i < 120; i++) sim.step(DT); // 2 s
    assert.true(sim.twist.vx > 0.45, `十分時間が経てば定常速度に近づく (vx = ${sim.twist.vx})`);
  });

  it('サンプルの壁は前進・後進デモの経路上にはない', () => {
    const world = compileWorld(SAMPLE_WORLD);
    // デモは x 1.7 → 2.3 を往復する (前端 +0.11)
    for (let x = 1.5; x <= 2.5; x += 0.05) {
      assert.false(roverCollides(world, { x, y: 1.5, heading: 0 }), `x=${x} で衝突しない`);
    }
  });

  it('最初の 2 秒は前進する', () => {
    const sim = new Simulation(compileWorld(SAMPLE_WORLD), compileFirmware(SAMPLE_FIRMWARE));
    const x0 = sim.pose.x;
    for (let i = 0; i < 120; i++) sim.step(DT); // 2 s
    assert.true(sim.pose.x > x0 + 0.3, `前進している (x: ${x0} → ${sim.pose.x})`);
  });

  it('前進・後進を繰り返して往復する (定常サイクルで元の位置に戻る)', () => {
    const sim = new Simulation(compileWorld(SAMPLE_WORLD), compileFirmware(SAMPLE_FIRMWARE));
    // モータの一次遅れがあるため、起動直後の過渡を除いた 1 周期 (t=2..6) で比較する
    for (let i = 0; i < 120; i++) sim.step(DT); // t = 2 s
    const x2 = sim.pose.x;
    for (let i = 0; i < 240; i++) sim.step(DT); // t = 6 s (後進 2 s + 前進 2 s)
    assert.approximately(sim.pose.x, x2, 0.02, '1 周期で往復する');
    assert.equal(sim.error, null);
  });

  it('サンプルマップには温度の異なる領域がある', () => {
    const world = compileWorld(SAMPLE_WORLD);
    const temps = new Set();
    for (let x = 0.1; x < world.map.width; x += 0.2) {
      for (let y = 0.1; y < world.map.height; y += 0.2) {
        temps.add(sampleGround(world.map, x, y).temperature);
      }
    }
    assert.true(temps.size >= 2, '温度が一様ではない');
  });
});

describe('ライントレースサンプル', () => {
  it('サンプル一覧に基本とライントレースがある', () => {
    assert.true(SAMPLES.length >= 2);
    assert.truthy(SAMPLES.find((s) => s.id === 'basic'));
    assert.truthy(SAMPLES.find((s) => s.id === 'linetrace'));
  });

  it('ライントレース環境はライン上と地の色が異なる', () => {
    const sample = SAMPLES.find((s) => s.id === 'linetrace');
    const world = compileWorld(sample.world);
    const onLine = sampleGround(world.map, world.rover.start.x, world.rover.start.y);
    const offLine = sampleGround(world.map, world.map.width / 2, world.map.height / 2);
    assert.true(
      Math.abs(onLine.brightness - offLine.brightness) > 0.3,
      `ラインと地の明度差がある (${onLine.brightness} vs ${offLine.brightness})`
    );
  });

  it('サンプルのファームウェア (制御なし) はエラーなく走る', () => {
    const sample = SAMPLES.find((s) => s.id === 'linetrace');
    const sim = new Simulation(compileWorld(sample.world), compileFirmware(sample.firmware));
    for (let i = 0; i < 120; i++) sim.step(DT); // 2 s
    assert.equal(sim.error, null);
    assert.true(sim.pose.x > 2.1, `前進している (x = ${sim.pose.x})`);
  });

  it('ライントレース制御を書けば周回できる (環境の回帰テスト)', () => {
    const sample = SAMPLES.find((s) => s.id === 'linetrace');
    // サンプルには制御を入れない方針のため、追従制御はテスト側で記述する
    // (PWM デューティ比での P 制御)
    const fw = `
      function loop(rover, dt) {
        const l = rover.sensor('line-left').brightness;
        const r = rover.sensor('line-right').brightness;
        rover.set('motor-left', 0.44 + 0.6 * (l - r));
        rover.set('motor-right', 0.44 + 0.6 * (r - l));
      }
    `;
    const sim = new Simulation(compileWorld(sample.world), compileFirmware(fw));
    let maxDev = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    for (let i = 0; i < 60 * 60; i++) {
      // 60 s
      sim.step(DT);
      const d = Math.hypot((sim.pose.x - 2.0) / 1.4, (sim.pose.y - 1.5) / 0.9);
      maxDev = Math.max(maxDev, Math.abs(d - 1));
      minX = Math.min(minX, sim.pose.x);
      maxX = Math.max(maxX, sim.pose.x);
    }
    assert.equal(sim.error, null);
    assert.true(maxDev < 0.15, `コースから外れない (max |d-1| = ${maxDev.toFixed(3)})`);
    assert.true(minX < 1 && maxX > 3, `コースを周回している (x: ${minX.toFixed(2)}..${maxX.toFixed(2)})`);
  });
});

export { runner };
