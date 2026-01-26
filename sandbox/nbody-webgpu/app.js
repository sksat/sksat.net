/**
 * N-Body Gravity Simulation App
 * Main application controller
 */

import { NBodySimulation, Particle, Vector3 } from './simulation.js';
import { WebGPURenderer, Camera } from './renderer.js';

/**
 * Energy Monitor - tracks total energy conservation
 */
class EnergyMonitor {
  constructor(controls, G) {
    this.controls = controls;
    this.G = G;
    this.initialEnergy = null;
    this.energyHistory = {
      time: [],
      total: [],
      kinetic: [],
      potential: [],
    };
    this.maxHistoryLength = 200;
    this.chart = null;
    this.frameCounter = 0;
    this.updateInterval = 10; // Update every N frames

    this.initChart();
  }

  initChart() {
    if (!this.controls.energyGraph || typeof uPlot === 'undefined') return;

    const opts = {
      width: 160,
      height: 60,
      cursor: { show: false },
      legend: { show: false },
      scales: {
        x: { time: false },
        y: { auto: true },
      },
      axes: [
        { show: false },
        {
          show: true,
          size: 30,
          stroke: '#666',
          grid: { stroke: '#2a2a3e', width: 1 },
          ticks: { stroke: '#2a2a3e' },
          font: '9px sans-serif',
          values: (u, vals) => vals.map(v => this.formatEnergy(v)),
        },
      ],
      series: [
        {},
        {
          label: 'Total',
          stroke: '#6eb5ff',
          width: 1.5,
          fill: 'rgba(110, 181, 255, 0.1)',
        },
      ],
    };

    const data = [[], []];
    this.chart = new uPlot(opts, data, this.controls.energyGraph);
  }

  formatEnergy(value) {
    if (value === null || value === undefined || !isFinite(value)) return '--';
    const abs = Math.abs(value);
    if (abs >= 1e6) return (value / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return (value / 1e3).toFixed(1) + 'K';
    if (abs >= 1) return value.toFixed(1);
    if (abs >= 0.01) return value.toFixed(2);
    return value.toExponential(1);
  }

  /**
   * Calculate total energy from particle data
   * @param {Float32Array} particleData - Particle data (28 floats per particle)
   * @returns {Object} { kinetic, potential, total }
   */
  calculateEnergy(particleData) {
    const numParticles = particleData.length / 28;
    let kinetic = 0;
    let potential = 0;

    // Extract positions, velocities, and masses
    const particles = [];
    for (let i = 0; i < numParticles; i++) {
      const offset = i * 28;
      particles.push({
        x: particleData[offset],
        y: particleData[offset + 1],
        z: particleData[offset + 2],
        mass: particleData[offset + 3],
        vx: particleData[offset + 4],
        vy: particleData[offset + 5],
        vz: particleData[offset + 6],
      });
    }

    // Calculate kinetic energy: sum of 0.5 * m * v^2
    for (const p of particles) {
      const v2 = p.vx * p.vx + p.vy * p.vy + p.vz * p.vz;
      kinetic += 0.5 * p.mass * v2;
    }

    // Calculate potential energy: sum of -G * m_i * m_j / r_ij for i < j
    for (let i = 0; i < numParticles; i++) {
      for (let j = i + 1; j < numParticles; j++) {
        const dx = particles[j].x - particles[i].x;
        const dy = particles[j].y - particles[i].y;
        const dz = particles[j].z - particles[i].z;
        const r = Math.sqrt(dx * dx + dy * dy + dz * dz + 0.0025); // softening^2
        potential -= this.G * particles[i].mass * particles[j].mass / r;
      }
    }

    return { kinetic, potential, total: kinetic + potential };
  }

  /**
   * Update energy monitoring (call periodically)
   */
  async update(renderer) {
    this.frameCounter++;
    if (this.frameCounter % this.updateInterval !== 0) return;

    try {
      const particleData = await renderer.readParticleData();
      const energy = this.calculateEnergy(particleData);

      // Store initial energy for drift calculation
      if (this.initialEnergy === null) {
        this.initialEnergy = energy.total;
      }

      // Add to history
      const time = this.energyHistory.time.length;
      this.energyHistory.time.push(time);
      this.energyHistory.total.push(energy.total);
      this.energyHistory.kinetic.push(energy.kinetic);
      this.energyHistory.potential.push(energy.potential);

      // Trim history
      if (this.energyHistory.time.length > this.maxHistoryLength) {
        this.energyHistory.time.shift();
        this.energyHistory.total.shift();
        this.energyHistory.kinetic.shift();
        this.energyHistory.potential.shift();
      }

      // Update chart
      if (this.chart) {
        this.chart.setData([
          this.energyHistory.time,
          this.energyHistory.total,
        ]);
      }

      // Update text displays
      if (this.controls.totalEnergy) {
        this.controls.totalEnergy.textContent = this.formatEnergy(energy.total);
      }

      if (this.controls.energyDrift && this.initialEnergy !== null) {
        const drift = (energy.total - this.initialEnergy) / Math.abs(this.initialEnergy);
        const driftPercent = (drift * 100).toFixed(4);
        this.controls.energyDrift.textContent = `${driftPercent}%`;
        // Color based on drift magnitude
        const color = Math.abs(drift) < 0.01 ? '#4a4' : Math.abs(drift) < 0.1 ? '#aa4' : '#a44';
        this.controls.energyDrift.style.color = color;
      }
    } catch (e) {
      // Ignore errors (e.g., buffer not ready)
    }
  }

  /**
   * Update gravitational constant (for preset changes)
   */
  setG(G) {
    this.G = G;
  }

  /**
   * Reset energy tracking
   */
  reset() {
    this.initialEnergy = null;
    this.energyHistory = {
      time: [],
      total: [],
      kinetic: [],
      potential: [],
    };
    this.frameCounter = 0;

    if (this.chart) {
      this.chart.setData([[], []]);
    }

    if (this.controls.totalEnergy) {
      this.controls.totalEnergy.textContent = '--';
    }
    if (this.controls.energyDrift) {
      this.controls.energyDrift.textContent = '--';
      this.controls.energyDrift.style.color = '#6eb5ff';
    }
  }

  /**
   * Update G constant
   */
  setG(G) {
    this.G = G;
    this.reset();
  }

  destroy() {
    if (this.chart) {
      this.chart.destroy();
      this.chart = null;
    }
  }
}

export class App {
  constructor(canvas, controls) {
    this.canvas = canvas;
    this.controls = controls;
    this.renderer = null;
    this.camera = new Camera();
    this.simulation = null;

    // Animation state
    this.running = false;
    this.animationId = null;
    this.lastTime = 0;
    this.fps = 0;
    this.frameCount = 0;
    this.fpsTime = 0;

    // Default parameters
    this.params = {
      numParticles: 1024,
      G: 1.0,
      softening: 0.05,
      dt: 0.002,
      preset: 'galaxy',
      integrator: 'verlet',  // Default: Velocity Verlet (2nd order symplectic)
    };

    // Mouse state for camera control
    this.mouseDown = false;
    this.lastMouseX = 0;
    this.lastMouseY = 0;

    // Energy monitoring
    this.energyMonitor = new EnergyMonitor(controls, this.params.G);

    this.setupEventListeners();
  }

  /**
   * Initialize the application
   */
  async initialize() {
    if (!WebGPURenderer.isSupported()) {
      throw new Error('WebGPU is not supported');
    }

    this.renderer = new WebGPURenderer(this.canvas);
    await this.renderer.initialize();

    this.resizeCanvas();
    this.initializeSimulation();

    return true;
  }

  /**
   * Initialize simulation with current parameters
   */
  initializeSimulation() {
    // Preset-specific parameters
    // Each preset has optimal dt, softening, and slider ranges
    const presetSettings = {
      galaxy: {
        dt: 0.002,
        dtMin: 0.0001,
        dtMax: 0.05,
        softening: 0.05,
      },
      random: {
        dt: 0.002,
        dtMin: 0.0001,
        dtMax: 0.05,
        softening: 0.05,
      },
      binary: {
        dt: 0.002,
        dtMin: 0.0001,
        dtMax: 0.1,   // Period ≈ 11, so dt=0.1 gives ~110 steps/orbit
        softening: 0.01,
      },
      solar: {
        // Properly non-dimensionalized solar system:
        // - Distance: AU, Time: years, Mass: Solar masses
        // - G = 4π² ≈ 39.48 (from Kepler's 3rd law)
        // - Earth orbital velocity ≈ 2π AU/year
        // dt reference: 0.001 years ≈ 8.76 hours
        dt: 0.001,
        dtMin: 0.0001,   // ≈ 52 min (high accuracy)
        dtMax: 0.02,     // ≈ 7.3 days (fast forward)
        softening: 0.001,  // Small softening for accurate orbits
        G: 4 * Math.PI * Math.PI,  // ≈ 39.48
      },
      collision: {
        // Two globular clusters colliding
        // Softening ~0.1 to reduce two-body heating in discrete system
        dt: 0.002,
        dtMin: 0.0001,
        dtMax: 0.05,
        softening: 0.1,
      },
    };

    // Apply preset-specific settings
    const settings = presetSettings[this.params.preset] || presetSettings.random;
    this.params.dt = settings.dt;
    this.params.softening = settings.softening;
    if (settings.G !== undefined) {
      this.params.G = settings.G;
    } else {
      this.params.G = 1.0;  // Default G for other presets
    }

    // Update UI sliders if they exist
    if (this.controls.timestep) {
      // Update slider range for this preset
      this.controls.timestep.min = settings.dtMin;
      this.controls.timestep.max = settings.dtMax;
      this.controls.timestep.value = this.params.dt;
      if (this.controls.timestepValue) {
        this.controls.timestepValue.textContent = this.params.dt.toExponential(1);
      }
    }

    this.simulation = new NBodySimulation({
      G: this.params.G,
      softening: this.params.softening,
      dt: this.params.dt,
    });

    // Generate initial conditions based on preset
    switch (this.params.preset) {
      case 'galaxy':
        this.simulation.particles = NBodySimulation.generateGalaxy(
          this.params.numParticles,
          2,
          50,
          this.params.G
        );
        this.camera.distance = 8;
        this.camera.phi = Math.PI / 4; // 45 degrees from above
        this.camera.theta = 0;
        break;
      case 'random':
        this.simulation.particles = NBodySimulation.generateRandomCluster(
          this.params.numParticles,
          2,
          [0.1, 1]
        );
        this.camera.distance = 8;
        this.camera.phi = Math.PI / 3;
        this.camera.theta = 0;
        break;
      case 'binary':
        // Equal mass binary with wider separation for visible orbits
        this.simulation.particles = NBodySimulation.generateTwoBody(
          10, 10, 4, this.params.G
        );
        this.camera.distance = 15;
        this.camera.phi = Math.PI / 4; // 45° from above (orbit in XZ plane)
        this.camera.theta = 0;
        break;
      case 'solar':
        this.simulation.particles = this.generateSolarSystem();
        this.camera.distance = 60;  // See all planets including Neptune at 30 AU
        this.camera.phi = Math.PI / 3;  // Slightly more overhead view
        this.camera.theta = 0;
        break;
      case 'collision':
        this.simulation.particles = this.generateCollidingClusters();
        this.camera.distance = 25;  // See both clusters with separation=12
        this.camera.phi = Math.PI / 4;
        this.camera.theta = 0;
        break;
      default:
        this.simulation.particles = NBodySimulation.generateRandomCluster(
          this.params.numParticles,
          2,
          [0.1, 1]
        );
    }

    // Upload to GPU
    const particleData = this.simulation.toFloat32Array();
    this.renderer.initializeBuffers(particleData, this.params);

    // Update camera
    this.updateCamera();
  }

  /**
   * Generate solar system with proper non-dimensionalization
   *
   * Unit system (astronomical units):
   * - Distance: AU (1 AU = Earth-Sun distance)
   * - Time: years
   * - Mass: Solar masses (M☉)
   * - G = 4π² ≈ 39.48 (from Kepler's 3rd law: T² = a³ for solar mass)
   *
   * This gives orbital velocities of order 2π (Earth ≈ 6.28 AU/year)
   * and allows reasonable dt values (0.001 years ≈ 8.76 hours)
   *
   * Data sources:
   * - NASA Planetary Fact Sheet: https://nssdc.gsfc.nasa.gov/planetary/factsheet/
   */
  generateSolarSystem() {
    const particles = [];

    // Sun: 1.0 solar mass
    const sunMass = 1.0;
    particles.push(
      new Particle(new Vector3(0, 0, 0), new Vector3(0, 0, 0), sunMass)
    );

    // Planets with realistic data
    // Distance in AU, mass in solar masses (M☉)
    // Mass conversion: M_earth = 3.003e-6 M☉
    const earthMassInSolar = 3.003e-6;
    const planets = [
      { name: 'Mercury', r: 0.387, m: 0.0553 * earthMassInSolar },
      { name: 'Venus',   r: 0.723, m: 0.815  * earthMassInSolar },
      { name: 'Earth',   r: 1.000, m: 1.0    * earthMassInSolar },
      { name: 'Mars',    r: 1.524, m: 0.107  * earthMassInSolar },
      { name: 'Jupiter', r: 5.203, m: 317.8  * earthMassInSolar },
      { name: 'Saturn',  r: 9.537, m: 95.2   * earthMassInSolar },
      { name: 'Uranus',  r: 19.19, m: 14.5   * earthMassInSolar },
      { name: 'Neptune', r: 30.07, m: 17.1   * earthMassInSolar },
    ];

    for (const planet of planets) {
      const angle = Math.random() * 2 * Math.PI;
      const x = planet.r * Math.cos(angle);
      const z = planet.r * Math.sin(angle);

      // Circular orbital velocity: v = sqrt(G * M_sun / r)
      // With G = 4π² and M_sun = 1: v = 2π / sqrt(r)
      // Earth (r=1): v = 2π ≈ 6.28 AU/year ✓
      const v = Math.sqrt(this.params.G * sunMass / planet.r);
      const vx = -v * Math.sin(angle);
      const vz = v * Math.cos(angle);

      particles.push(
        new Particle(
          new Vector3(x, 0, z),
          new Vector3(vx, 0, vz),
          planet.m
        )
      );
    }

    return particles;
  }

  /**
   * Generate two colliding globular clusters
   * Creates two spherical clusters in virial equilibrium with opposing bulk velocities
   *
   * Virial theorem: 2K + U = 0
   * For a uniform density sphere: σ ≈ sqrt(G * M / (2 * R))
   * where σ is the 1D velocity dispersion
   *
   * Reference: 国立天文台 天文情報センター
   */
  generateCollidingClusters() {
    const particles = [];
    const n = Math.floor(this.params.numParticles / 2);

    // Cluster parameters
    const clusterRadius = 1.5;
    const separation = 12;     // Distance between cluster centers (start far apart)
    const massPerParticle = 1.0;
    const G = this.params.G;

    // Total mass of each cluster
    const clusterMass = n * massPerParticle;

    // Velocity dispersion from virial equilibrium
    // For uniform sphere: U = -3GM²/(5R), 2K = -U → σ² = GM/(5R) = 0.2*GM/R
    const sigma = Math.sqrt(0.2 * G * clusterMass / clusterRadius);

    // Bulk velocity for collision
    // Slow approach - let gravity accelerate them
    const approachSpeed = 0.3 * sigma;

    // Box-Muller transform for Gaussian random numbers
    const gaussianRandom = () => {
      const u1 = Math.random();
      const u2 = Math.random();
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    };

    // Generate cluster 1 (left, moving right)
    for (let i = 0; i < n; i++) {
      // Uniform distribution in sphere
      const u = Math.random();
      const v = Math.random();
      const theta = 2 * Math.PI * u;
      const phi = Math.acos(2 * v - 1);
      const r = clusterRadius * Math.cbrt(Math.random());

      const x = r * Math.sin(phi) * Math.cos(theta) - separation / 2;
      const y = r * Math.sin(phi) * Math.sin(theta);
      const z = r * Math.cos(phi);

      // Isotropic Gaussian velocity distribution (Maxwell-Boltzmann)
      // Plus bulk motion toward the other cluster
      const vx = approachSpeed / 2 + sigma * gaussianRandom();
      const vy = sigma * gaussianRandom();
      const vz = sigma * gaussianRandom();

      particles.push(
        new Particle(new Vector3(x, y, z), new Vector3(vx, vy, vz), massPerParticle)
      );
    }

    // Generate cluster 2 (right, moving left)
    for (let i = 0; i < n; i++) {
      const u = Math.random();
      const v = Math.random();
      const theta = 2 * Math.PI * u;
      const phi = Math.acos(2 * v - 1);
      const r = clusterRadius * Math.cbrt(Math.random());

      const x = r * Math.sin(phi) * Math.cos(theta) + separation / 2;
      const y = r * Math.sin(phi) * Math.sin(theta);
      const z = r * Math.cos(phi);

      const vx = -approachSpeed / 2 + sigma * gaussianRandom();
      const vy = sigma * gaussianRandom();
      const vz = sigma * gaussianRandom();

      particles.push(
        new Particle(new Vector3(x, y, z), new Vector3(vx, vy, vz), massPerParticle)
      );
    }

    return particles;
  }

  /**
   * Setup event listeners for controls
   */
  setupEventListeners() {
    // Canvas mouse events for camera control
    this.canvas.addEventListener('mousedown', (e) => {
      this.mouseDown = true;
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
    });

    window.addEventListener('mouseup', () => {
      this.mouseDown = false;
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.mouseDown) return;

      const deltaX = e.clientX - this.lastMouseX;
      const deltaY = e.clientY - this.lastMouseY;

      this.camera.orbit(deltaX * 0.01, deltaY * 0.01);
      this.updateCamera(true);

      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
    });

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.camera.zoom(-e.deltaY * 0.001);
      this.updateCamera(true);
    });

    // Touch events for mobile
    this.canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        this.mouseDown = true;
        this.lastMouseX = e.touches[0].clientX;
        this.lastMouseY = e.touches[0].clientY;
      }
    });

    this.canvas.addEventListener('touchend', () => {
      this.mouseDown = false;
    });

    this.canvas.addEventListener('touchmove', (e) => {
      if (!this.mouseDown || e.touches.length !== 1) return;
      e.preventDefault();

      const deltaX = e.touches[0].clientX - this.lastMouseX;
      const deltaY = e.touches[0].clientY - this.lastMouseY;

      this.camera.orbit(deltaX * 0.01, deltaY * 0.01);
      this.updateCamera(true);

      this.lastMouseX = e.touches[0].clientX;
      this.lastMouseY = e.touches[0].clientY;
    });

    // Window resize
    window.addEventListener('resize', () => this.resizeCanvas());

    // Control inputs
    if (this.controls.playPause) {
      this.controls.playPause.addEventListener('click', () => this.togglePlay());
    }

    if (this.controls.reset) {
      this.controls.reset.addEventListener('click', () => this.reset());
    }

    if (this.controls.preset) {
      this.controls.preset.addEventListener('change', (e) => {
        this.params.preset = e.target.value;
        this.reset();
      });
    }

    if (this.controls.particles) {
      this.controls.particles.addEventListener('change', (e) => {
        this.params.numParticles = parseInt(e.target.value, 10);
        this.reset();
      });
    }

    if (this.controls.gravity) {
      this.controls.gravity.addEventListener('input', (e) => {
        this.params.G = parseFloat(e.target.value);
        this.renderer.updateParams(this.params);
        this.energyMonitor.setG(this.params.G);
        if (this.controls.gravityValue) {
          this.controls.gravityValue.textContent = this.params.G.toFixed(2);
        }
      });
    }

    if (this.controls.timestep) {
      this.controls.timestep.addEventListener('input', (e) => {
        this.params.dt = parseFloat(e.target.value);
        this.renderer.updateParams(this.params);
        if (this.controls.timestepValue) {
          this.controls.timestepValue.textContent = this.params.dt.toExponential(1);
        }
      });
    }

    if (this.controls.integrator) {
      this.controls.integrator.addEventListener('change', (e) => {
        this.params.integrator = e.target.value;
        this.renderer.setIntegrator(e.target.value);
        this.energyMonitor.reset();  // Reset energy tracking on method change
      });
    }

    if (this.controls.trail) {
      this.controls.trail.addEventListener('change', (e) => {
        this.renderer.setTrailEnabled(e.target.checked);
      });
    }
  }

  /**
   * Resize canvas to fill container
   */
  resizeCanvas() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;

    this.camera.aspect = rect.width / rect.height;
    this.updateCamera();
  }

  /**
   * Update camera matrices in GPU buffer
   * @param {boolean} render - Whether to render after updating (for pause state)
   */
  updateCamera(render = false) {
    if (!this.renderer || !this.renderer.initialized) return;

    const viewProj = this.camera.getViewProjectionMatrix();
    const eye = this.camera.getEyePosition();
    this.renderer.updateCamera(viewProj, eye);

    // Render if paused and requested
    if (render && !this.running) {
      this.renderer.render();
    }
  }

  /**
   * Toggle simulation play/pause
   */
  togglePlay() {
    if (this.running) {
      this.pause();
    } else {
      this.play();
    }
  }

  /**
   * Start simulation
   */
  play() {
    if (this.running) return;

    this.running = true;
    this.lastTime = performance.now();
    this.fpsTime = this.lastTime;
    this.frameCount = 0;

    if (this.controls.playPause) {
      this.controls.playPause.textContent = 'Pause';
    }

    this.animate();
  }

  /**
   * Pause simulation
   */
  pause() {
    this.running = false;

    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }

    if (this.controls.playPause) {
      this.controls.playPause.textContent = 'Play';
    }
  }

  /**
   * Reset simulation
   */
  reset() {
    this.pause();
    this.initializeSimulation();
    this.energyMonitor.setG(this.params.G);  // Update G for new preset
    this.energyMonitor.reset();
    this.renderer.render();
  }

  /**
   * Animation loop
   */
  animate() {
    if (!this.running) return;

    const now = performance.now();

    // FPS calculation
    this.frameCount++;
    if (now - this.fpsTime >= 1000) {
      this.fps = this.frameCount;
      this.frameCount = 0;
      this.fpsTime = now;

      if (this.controls.fps) {
        this.controls.fps.textContent = `${this.fps} FPS`;
      }
    }

    // Run compute pass (advance simulation)
    this.renderer.runComputePass();

    // Update trail buffer (GPU compute, no CPU overhead)
    this.renderer.updateTrail();

    // Update energy monitoring (async, doesn't block)
    this.energyMonitor.update(this.renderer);

    // Render
    this.renderer.render();

    this.lastTime = now;
    this.animationId = requestAnimationFrame(() => this.animate());
  }

  /**
   * Clean up resources
   */
  destroy() {
    this.pause();
    if (this.renderer) {
      this.renderer.destroy();
    }
  }
}
