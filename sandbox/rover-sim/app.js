/**
 * rover-sim UI
 *
 * 左: シミュレータ表示 (canvas)、右: IDE ペイン (2 タブのコードエディタ +
 * センサ/アクチュエータモニタ + コンソール)。エンジンは sim.js、エディタは highlight.js。
 *
 * 操作モデル:
 *   - ▶ 実行 (IDE 側): エディタのスクリプトを読み込み、最初から実行する
 *   - ⏸ 一時停止 / ▶ 再開 (シミュレータ側): 時間を止める・進める
 *   - ⟲ リセット: 読み込み済みスクリプトのまま t=0 に戻す
 */

import { compileWorld, compileFirmware, Simulation, sampleGround, toHex } from './sim.js';
import { CodeEditor } from './highlight.js';
import { SAMPLES, findSample } from './samples.js';
import {
  encodeText,
  decodeText,
  buildShareUrl,
  PARAM_WORLD,
  PARAM_FIRMWARE,
  PARAM_SAMPLE,
  PARAM_SPEED,
  PARAM_VIEW,
} from './share.js';

const STORAGE_WORLD = 'rover-sim.world';
const STORAGE_FIRMWARE = 'rover-sim.firmware';
const FIXED_DT = 1 / 60;
const MAX_TRAIL = 3000;
const TEMP_COLD = { r: 59, g: 76, b: 192 };
const TEMP_MID = { r: 244, g: 244, b: 244 };
const TEMP_HOT = { r: 180, g: 4, b: 38 };

function lerpColor(a, b, t) {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

/** 温度 0..1 → 寒色-暖色 */
function tempColor(u) {
  return u < 0.5 ? lerpColor(TEMP_COLD, TEMP_MID, u * 2) : lerpColor(TEMP_MID, TEMP_HOT, u * 2 - 1);
}

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode 等では保存しない */
  }
}

export function initApp() {
  const $ = (id) => document.getElementById(id);
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');
  const canvasWrap = $('canvas-wrap');
  const simPane = $('sim-pane');
  const consoleEl = $('console');
  const sensorTable = $('sensor-table');
  const actuatorTable = $('actuator-table');
  const statusEl = $('status');
  const btnPause = $('btn-pause');
  const btnReset = $('btn-reset');
  const btnFull = $('btn-full');
  const btnExec = $('btn-exec');
  const selSample = $('sel-sample');
  const btnShare = $('btn-share');
  const selSpeed = $('sel-speed');
  const selView = $('sel-view');
  const splitter = $('splitter');
  const idePane = $('ide-pane');

  // ---- 状態 ----
  let sim = null;
  let running = true;
  let speed = 1;
  let viewMode = 'color'; // 'color' | 'temp'
  let trail = [];
  let trailSkip = 0;
  let consumedLogs = 0;
  let runtimeErrorShown = false;
  let groundTex = null; // { color: canvas, temp: canvas, tMin, tMax }
  let sensorRows = new Map();
  let telemetryRows = new Map();
  let actuatorRows = new Map();

  // ---- エディタ ----
  const worldEditor = new CodeEditor($('editor-world'), {
    value: storageGet(STORAGE_WORLD) ?? SAMPLES[0].world,
  });
  const firmwareEditor = new CodeEditor($('editor-firmware'), {
    value: storageGet(STORAGE_FIRMWARE) ?? SAMPLES[0].firmware,
  });

  {
    // 先頭はプレースホルダにして、同じサンプルを選び直しても change が発火するようにする
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'サンプル…';
    selSample.appendChild(placeholder);
    for (const sample of SAMPLES) {
      const opt = document.createElement('option');
      opt.value = sample.id;
      opt.textContent = sample.name;
      selSample.appendChild(opt);
    }
  }

  const tabs = Array.from(document.querySelectorAll('.ide-tabs .tab'));
  function selectTab(name) {
    for (const tab of tabs) tab.classList.toggle('active', tab.dataset.tab === name);
    $('editor-world').classList.toggle('hidden', name !== 'world');
    $('editor-firmware').classList.toggle('hidden', name !== 'firmware');
  }
  for (const tab of tabs) tab.addEventListener('click', () => selectTab(tab.dataset.tab));

  // ---- コンソール ----
  function appendLine(line) {
    consoleEl.appendChild(line);
    while (consoleEl.children.length > 400) consoleEl.removeChild(consoleEl.firstChild);
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  function pushConsole(text, cls = '') {
    const line = document.createElement('div');
    line.className = `line ${cls}`;
    line.textContent = text;
    appendLine(line);
  }

  function pushSimLog(entry) {
    const line = document.createElement('div');
    line.className = 'line';
    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = entry.time.toFixed(2);
    line.appendChild(time);
    line.appendChild(document.createTextNode(entry.message));
    appendLine(line);
  }

  // ---- 地面テクスチャ ----
  function bakeGroundTextures(map) {
    const maxTex = 800;
    const pxPerM = maxTex / Math.max(map.width, map.height);
    const tw = Math.max(2, Math.round(map.width * pxPerM));
    const th = Math.max(2, Math.round(map.height * pxPerM));

    const colorCanvas = document.createElement('canvas');
    colorCanvas.width = tw;
    colorCanvas.height = th;
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = tw;
    tempCanvas.height = th;

    const colorImg = ctx.createImageData(tw, th);
    const temps = new Float64Array(tw * th);
    const wallMask = new Uint8Array(tw * th);
    let tMin = Infinity;
    let tMax = -Infinity;
    let groundErrors = 0;

    for (let py = 0; py < th; py++) {
      // テクスチャ上端 = ワールド y 最大 (y 軸反転)
      const wy = map.height * (1 - (py + 0.5) / th);
      for (let px = 0; px < tw; px++) {
        const wx = map.width * ((px + 0.5) / tw);
        let g;
        try {
          g = sampleGround(map, wx, wy);
        } catch {
          groundErrors++;
          g = { color: { r: 60, g: 60, b: 60 }, temperature: 20 };
        }
        const i = py * tw + px;
        const o = i * 4;
        colorImg.data[o] = g.color.r;
        colorImg.data[o + 1] = g.color.g;
        colorImg.data[o + 2] = g.color.b;
        colorImg.data[o + 3] = 255;
        if (g.wall) {
          // 壁は温度を持たないので温度レンジから除外する
          wallMask[i] = 1;
        } else {
          const t = g.temperature;
          temps[i] = t;
          if (t < tMin) tMin = t;
          if (t > tMax) tMax = t;
        }
      }
    }
    colorCanvas.getContext('2d').putImageData(colorImg, 0, 0);

    const tempImg = ctx.createImageData(tw, th);
    const range = tMax - tMin;
    for (let i = 0; i < temps.length; i++) {
      const o = i * 4;
      if (wallMask[i]) {
        // 壁は温度ビューでも壁色で描く
        tempImg.data[o] = colorImg.data[o];
        tempImg.data[o + 1] = colorImg.data[o + 1];
        tempImg.data[o + 2] = colorImg.data[o + 2];
        tempImg.data[o + 3] = 255;
        continue;
      }
      const u = range > 1e-9 ? (temps[i] - tMin) / range : 0.5;
      const c = tempColor(u);
      tempImg.data[o] = c.r;
      tempImg.data[o + 1] = c.g;
      tempImg.data[o + 2] = c.b;
      tempImg.data[o + 3] = 255;
    }
    tempCanvas.getContext('2d').putImageData(tempImg, 0, 0);

    if (groundErrors > 0) {
      pushConsole(`警告: map.ground() が ${groundErrors} 回例外を投げました`, 'error');
    }
    groundTex = { color: colorCanvas, temp: tempCanvas, tMin, tMax };
  }

  // ---- テレメトリ / アクチュエータモニタ ----
  function buildRow(table, id) {
    const tr = document.createElement('tr');
    const tdId = document.createElement('td');
    tdId.className = 'sensor-id';
    tdId.textContent = id;
    const tdValue = document.createElement('td');
    tdValue.textContent = '--';
    tr.append(tdId, tdValue);
    table.appendChild(tr);
    return tdValue;
  }

  function rebuildMonitor() {
    sensorTable.innerHTML = '';
    actuatorTable.innerHTML = '';
    sensorRows = new Map();
    telemetryRows = new Map();
    actuatorRows = new Map();
    if (!sim) return;
    for (const def of sim.world.rover.sensors) {
      sensorRows.set(def.id, buildRow(sensorTable, def.id));
    }
    for (const def of sim.world.rover.actuators) {
      actuatorRows.set(def.id, buildRow(actuatorTable, def.id));
    }
  }

  /** テレメトリ値 (センサ読み取り or 任意の値) をセルに描く */
  function renderTelemetryCell(td, entry) {
    const v = entry.value;
    td.innerHTML = '';
    if (v && typeof v === 'object' && typeof v.hex === 'string') {
      // ground センサの読み値
      const chip = document.createElement('i');
      chip.className = 'chip';
      chip.style.background = v.hex;
      td.appendChild(chip);
      const label = v.wall ? '  壁' : v.outside ? '  場外' : '';
      td.appendChild(
        document.createTextNode(
          `${v.hex}  明度 ${v.brightness.toFixed(2)}  ${v.temperature.toFixed(1)} °C${label}`
        )
      );
    } else if (typeof v === 'number') {
      td.textContent = String(Number(v.toFixed(4)));
    } else if (typeof v === 'object' && v !== null) {
      td.textContent = JSON.stringify(v);
    } else {
      td.textContent = String(v);
    }
    const time = document.createElement('span');
    time.className = 'tm-time';
    time.textContent = ` @ ${entry.time.toFixed(1)}s`;
    td.appendChild(time);
  }

  function updateMonitor() {
    if (!sim) return;
    // センサ: ファームウェアが明示的に読んだ値だけを表示する
    for (const def of sim.world.rover.sensors) {
      const td = sensorRows.get(def.id);
      const entry = sim.sensorReadings[def.id];
      if (td && entry) renderTelemetryCell(td, entry);
    }
    // 任意のテレメトリ (rover.telemetry で送られた値)。新しいキーは行を追加する
    for (const [key, entry] of Object.entries(sim.telemetry)) {
      let td = telemetryRows.get(key);
      if (!td) {
        td = buildRow(sensorTable, key);
        telemetryRows.set(key, td);
      }
      renderTelemetryCell(td, entry);
    }
    for (const def of sim.world.rover.actuators) {
      const td = actuatorRows.get(def.id);
      if (td) td.textContent = sim.commands[def.id].toFixed(3);
    }
  }

  // ---- 描画 ----
  function fitCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(canvasWrap.clientWidth * dpr);
    const h = Math.round(canvasWrap.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return dpr;
  }

  function draw() {
    const dpr = fitCanvas();
    const cw = canvas.width;
    const ch = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0e1116';
    ctx.fillRect(0, 0, cw, ch);
    if (!sim || !groundTex) return;

    const map = sim.world.map;
    const pad = 14 * dpr;
    const s = Math.min((cw - pad * 2) / map.width, (ch - pad * 2) / map.height);
    if (!(s > 0)) return;
    const ox = (cw - map.width * s) / 2;
    const oy = (ch - map.height * s) / 2;
    const toScreen = (x, y) => [ox + x * s, oy + (map.height - y) * s];

    // 地面
    const tex = viewMode === 'temp' ? groundTex.temp : groundTex.color;
    ctx.drawImage(tex, ox, oy, map.width * s, map.height * s);
    ctx.strokeStyle = '#3a4354';
    ctx.lineWidth = 1 * dpr;
    ctx.strokeRect(ox, oy, map.width * s, map.height * s);

    // 温度ビューの凡例
    if (viewMode === 'temp') drawTempLegend(ox, oy, map, s, dpr);

    // 走行軌跡
    if (trail.length > 1) {
      ctx.beginPath();
      for (let i = 0; i < trail.length; i++) {
        const [tx, ty] = toScreen(trail[i].x, trail[i].y);
        if (i === 0) ctx.moveTo(tx, ty);
        else ctx.lineTo(tx, ty);
      }
      ctx.strokeStyle = 'rgba(110, 181, 255, 0.55)';
      ctx.lineWidth = 1.5 * dpr;
      ctx.stroke();
    }

    drawRover(toScreen, s);
  }

  function drawTempLegend(ox, oy, map, s, dpr) {
    const w = 110 * dpr;
    const h = 10 * dpr;
    const x = ox + 10 * dpr;
    const y = oy + map.height * s - h - 10 * dpr;
    const grad = ctx.createLinearGradient(x, 0, x + w, 0);
    for (let i = 0; i <= 10; i++) {
      grad.addColorStop(i / 10, toHex(tempColor(i / 10)));
    }
    ctx.fillStyle = 'rgba(14, 17, 22, 0.75)';
    ctx.fillRect(x - 6 * dpr, y - 18 * dpr, w + 12 * dpr, h + 24 * dpr);
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#dfe3ea';
    ctx.font = `${10 * dpr}px sans-serif`;
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    ctx.fillText(`${groundTex.tMin.toFixed(0)}°C`, x, y - 3 * dpr);
    ctx.textAlign = 'right';
    ctx.fillText(`${groundTex.tMax.toFixed(0)}°C`, x + w, y - 3 * dpr);
    ctx.textAlign = 'left';
  }

  function drawRover(toScreen, s) {
    const rover = sim.world.rover;
    const { length: L, width: W } = rover.body;
    const [sx, sy] = toScreen(sim.pose.x, sim.pose.y);

    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(-sim.pose.heading);
    ctx.scale(s, -s); // 以降は機体座標 [m] (x 前方, y 左)

    // 装飾パーツ (タイヤなど) は車体の下に描く
    for (const p of rover.parts) {
      ctx.fillStyle = p.color;
      if (p.shape === 'rect') {
        ctx.fillRect(p.x - p.w / 2, p.y - p.h / 2, p.w, p.h);
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 車体
    ctx.fillStyle = rover.body.color;
    ctx.fillRect(-L / 2, -W / 2, L, W);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.lineWidth = 0.006;
    ctx.strokeRect(-L / 2, -W / 2, L, W);

    // 進行方向マーカー
    ctx.beginPath();
    ctx.moveTo(L / 2 + 0.035, 0);
    ctx.lineTo(L / 2 - 0.015, 0.03);
    ctx.lineTo(L / 2 - 0.015, -0.03);
    ctx.closePath();
    ctx.fillStyle = '#6eb5ff';
    ctx.fill();

    // センサ (明示的に読まれたものは最後の読み値で塗る)
    for (const def of rover.sensors) {
      const reading = sim.sensorReadings[def.id]?.value;
      ctx.beginPath();
      ctx.arc(def.x, def.y, 0.012, 0, Math.PI * 2);
      ctx.fillStyle = reading && reading.hex ? reading.hex : '#b48ead';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 0.004;
      ctx.stroke();
    }

    ctx.restore();
  }

  // ---- シミュレーション制御 ----

  let lastSources = null; // 最後に実行したスクリプト (リセット時の再コンパイル用)

  /** スクリプトをコンパイルしてシミュレーションを最初から作り直す */
  function buildSim(worldSrc, firmwareSrc) {
    const world = compileWorld(worldSrc);
    // ground() を一度呼んで即時エラーを検出する
    sampleGround(world.map, world.map.width / 2, world.map.height / 2);
    const firmware = compileFirmware(firmwareSrc);
    sim = new Simulation(world, firmware);
    bakeGroundTextures(world.map);
    trail = [];
    consumedLogs = 0;
    runtimeErrorShown = false;
    rebuildMonitor();
  }

  /**
   * エディタのスクリプトを読み込み、最初から実行する。
   * save: false のとき localStorage を上書きしない (共有 URL からの読み込み用)。
   */
  function execScripts({ silent = false, save = true } = {}) {
    const worldSrc = worldEditor.getValue();
    const firmwareSrc = firmwareEditor.getValue();
    try {
      buildSim(worldSrc, firmwareSrc);
      lastSources = { world: worldSrc, firmware: firmwareSrc };
      if (save) {
        storageSet(STORAGE_WORLD, worldSrc);
        storageSet(STORAGE_FIRMWARE, firmwareSrc);
        // 内容が変わったので古い共有パラメータを URL から外す
        const sp = new URLSearchParams(location.search);
        if (sp.has(PARAM_WORLD) || sp.has(PARAM_FIRMWARE) || sp.has(PARAM_SAMPLE)) {
          history.replaceState(null, '', location.pathname);
        }
      }
      setRunning(true);
      if (!silent) pushConsole('スクリプトを読み込み、実行を開始しました', 'ok');
      return true;
    } catch (e) {
      pushConsole(`エラー: ${e.message}`, 'error');
      return false;
    }
  }

  /**
   * 現在のエディタ内容と設定を載せた共有 URL を作り、コピーする。
   * 単純な設定は素のクエリ、コードは world / firmware に個別の base64url。
   * 未編集のサンプルそのままなら sample=<id> だけを載せる。
   */
  async function shareCurrent() {
    try {
      const worldSrc = worldEditor.getValue();
      const firmwareSrc = firmwareEditor.getValue();
      const settings = { [PARAM_SPEED]: speed, [PARAM_VIEW]: viewMode };

      const sample = findSample(worldSrc, firmwareSrc);
      const params = sample
        ? { [PARAM_SAMPLE]: sample.id, ...settings }
        : {
            ...settings,
            [PARAM_WORLD]: await encodeText(worldSrc),
            [PARAM_FIRMWARE]: await encodeText(firmwareSrc),
          };

      const url = buildShareUrl(location.href, params);
      history.replaceState(null, '', url);
      if (url.length > 8000) {
        pushConsole(`注意: 共有 URL が長め (${url.length} 文字) です。一部のサービスでは切れる可能性があります`, 'info');
      }
      try {
        await navigator.clipboard.writeText(url);
        pushConsole(`共有 URL をコピーしました (${url.length} 文字)`, 'ok');
      } catch {
        pushConsole('共有 URL をアドレスバーに反映しました (コピーは手動でどうぞ)', 'info');
      }
    } catch (e) {
      pushConsole(`共有 URL の生成に失敗しました: ${e.message}`, 'error');
    }
  }

  /** 起動時: 共有 URL があればスクリプトと設定を復元して実行する */
  async function initFromUrl() {
    const sp = new URLSearchParams(location.search);

    // 単純な設定はコードの有無に関わらず反映する
    if ([1, 2, 4, 8].includes(+sp.get(PARAM_SPEED))) {
      speed = +sp.get(PARAM_SPEED);
      selSpeed.value = String(speed);
    }
    const view = sp.get(PARAM_VIEW);
    if (view === 'temp' || view === 'color') {
      viewMode = view;
      selView.value = view;
    }

    try {
      if (sp.has(PARAM_WORLD) || sp.has(PARAM_FIRMWARE)) {
        if (sp.has(PARAM_WORLD)) worldEditor.setValue(await decodeText(sp.get(PARAM_WORLD)));
        if (sp.has(PARAM_FIRMWARE)) firmwareEditor.setValue(await decodeText(sp.get(PARAM_FIRMWARE)));
        const ok = execScripts({ silent: true, save: false });
        pushConsole(
          ok ? '共有 URL からスクリプトを読み込みました' : '共有 URL のスクリプトにエラーがあります',
          ok ? 'ok' : 'error'
        );
        return true;
      }

      const sampleId = sp.get(PARAM_SAMPLE);
      if (sampleId) {
        const sample = SAMPLES.find((s) => s.id === sampleId);
        if (!sample) {
          pushConsole(`共有 URL のサンプルが見つかりません: ${sampleId}`, 'error');
          return false;
        }
        worldEditor.setValue(sample.world);
        firmwareEditor.setValue(sample.firmware);
        execScripts({ silent: true, save: false });
        pushConsole(`共有 URL からサンプル「${sample.name}」を読み込みました`, 'ok');
        return true;
      }
    } catch (e) {
      pushConsole(`共有 URL の読み込みに失敗しました: ${e.message}`, 'error');
    }
    return false;
  }

  /**
   * 実行中のスクリプトのまま t=0 に戻す。
   * ハードウェア記述が閉包変数で内部状態 (モータ速度など) を持てるため、
   * 再コンパイルして完全に初期化する。エディタの未実行の編集は反映しない。
   */
  function resetSim() {
    if (!lastSources) return;
    try {
      buildSim(lastSources.world, lastSources.firmware);
      pushConsole('リセットしました (t = 0)', 'info');
    } catch (e) {
      pushConsole(`エラー: ${e.message}`, 'error');
    }
  }

  function setRunning(v) {
    running = v;
    btnPause.textContent = running ? '⏸ 一時停止' : '▶ 再開';
  }

  // ---- UI イベント ----
  btnPause.addEventListener('click', () => setRunning(!running));
  btnReset.addEventListener('click', resetSim);
  btnExec.addEventListener('click', () => execScripts());
  btnShare.addEventListener('click', () => shareCurrent());
  selSample.addEventListener('change', () => {
    const sample = SAMPLES.find((s) => s.id === selSample.value);
    selSample.value = ''; // プレースホルダに戻す
    if (!sample) return;
    worldEditor.setValue(sample.world);
    firmwareEditor.setValue(sample.firmware);
    pushConsole(`サンプル「${sample.name}」を読み込みました`, 'info');
    if (execScripts({ silent: true })) {
      // サンプルを選んだだけの状態は sample= だけの URL にしておく
      history.replaceState(null, '', buildShareUrl(location.href, { [PARAM_SAMPLE]: sample.id }));
    }
  });
  selSpeed.addEventListener('change', () => {
    speed = Number(selSpeed.value);
  });
  selView.addEventListener('change', () => {
    viewMode = selView.value;
  });

  btnFull.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else simPane.requestFullscreen();
  });
  document.addEventListener('fullscreenchange', () => {
    btnFull.textContent = document.fullscreenElement ? '⛶ 全画面解除' : '⛶ 全画面';
  });

  window.addEventListener('keydown', (e) => {
    const inEditor = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      execScripts();
    } else if (e.code === 'Space' && !inEditor && e.target.tagName !== 'BUTTON' && e.target.tagName !== 'SELECT') {
      e.preventDefault();
      setRunning(!running);
    }
  });

  // スプリッタでペイン幅を変更
  splitter.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    splitter.classList.add('dragging');
    splitter.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      const rect = document.querySelector('.main').getBoundingClientRect();
      const width = rect.right - ev.clientX;
      idePane.style.width = `${Math.min(Math.max(width, 300), rect.width * 0.75)}px`;
    };
    const onUp = () => {
      splitter.classList.remove('dragging');
      splitter.removeEventListener('pointermove', onMove);
      splitter.removeEventListener('pointerup', onUp);
    };
    splitter.addEventListener('pointermove', onMove);
    splitter.addEventListener('pointerup', onUp);
  });

  // ---- メインループ ----
  let acc = 0;
  let lastTime = performance.now();

  function frame(now) {
    const dtReal = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;

    if (sim && running && !sim.error) {
      acc += dtReal * speed;
      let steps = 0;
      while (acc >= FIXED_DT && steps < 480) {
        sim.step(FIXED_DT);
        acc -= FIXED_DT;
        steps++;
        if (++trailSkip % 3 === 0) {
          trail.push({ x: sim.pose.x, y: sim.pose.y });
          if (trail.length > MAX_TRAIL) trail.shift();
        }
      }
    } else {
      acc = 0;
    }

    if (sim) {
      // 新しいログをコンソールへ
      while (consumedLogs < sim.logs.length) pushSimLog(sim.logs[consumedLogs++]);
      if (sim.error && !runtimeErrorShown) {
        runtimeErrorShown = true;
        pushConsole('エラーで停止しました。スクリプトを修正して「▶ 実行」してください。', 'error');
      }

      const state = sim.error
        ? '<span class="state-error">エラー</span>'
        : running
          ? '<span class="state-run">実行中</span>'
          : '<span class="state-pause">停止</span>';
      const touch = !sim.error && sim.collided ? ' <span class="state-touch">⚠ 接触</span>' : '';
      statusEl.innerHTML = `${state}${touch}  t = ${sim.time.toFixed(1)} s  x${speed}`;
    }

    updateMonitor();
    draw();
    requestAnimationFrame(frame);
  }

  // ---- 起動 ----
  (async () => {
    // 優先順: 共有 URL > localStorage > サンプル
    if (!(await initFromUrl())) {
      if (!execScripts({ silent: true, save: false })) {
        // 保存されたスクリプトが壊れている場合はサンプルへフォールバック
        worldEditor.setValue(SAMPLES[0].world);
        firmwareEditor.setValue(SAMPLES[0].firmware);
        execScripts({ silent: true, save: false });
      }
    }
    pushConsole('▶ 実行 (Ctrl+Enter) でスクリプトを読み込んで実行 / Space で一時停止・再開 / 🔗 共有 で URL 共有', 'info');
    selectTab('firmware');
    requestAnimationFrame(frame);
  })();
}
