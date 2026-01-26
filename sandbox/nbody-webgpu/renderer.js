/**
 * WebGPU Renderer for N-Body Simulation
 * Handles GPU initialization, compute passes, and rendering
 */

export class WebGPURenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.device = null;
    this.context = null;
    this.format = null;

    // Pipelines
    this.computePipeline = null;
    this.renderPipeline = null;

    // Buffers
    this.particleBuffers = [null, null]; // Double buffer for ping-pong
    this.paramsBuffer = null;
    this.cameraBuffer = null;

    // Bind groups
    this.computeBindGroups = [null, null];

    // State
    this.currentBuffer = 0;
    this.numParticles = 0;
    this.initialized = false;

    // Trail effect
    this.trailEnabled = false;
    this.trailPipeline = null;
    this.trailUpdatePipeline = null;
    this.trailBuffer = null;
    this.trailLength = 64;  // Number of positions to store per particle
    this.trailHead = 0;     // Current write position in ring buffer
    this.trailUpdateBindGroups = [null, null];
  }

  /**
   * Check if WebGPU is supported
   */
  static isSupported() {
    return !!navigator.gpu;
  }

  /**
   * Initialize WebGPU device and context
   */
  async initialize() {
    if (!navigator.gpu) {
      throw new Error('WebGPU is not supported in this browser (navigator.gpu is undefined)');
    }

    // Try to get a GPU adapter, with fallback options
    let adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance',
    });

    if (!adapter) {
      // Try fallback adapter (software rendering)
      console.log('No high-performance adapter, trying fallback...');
      adapter = await navigator.gpu.requestAdapter({
        powerPreference: 'low-power',
      });
    }

    if (!adapter) {
      // Try forcing fallback adapter
      console.log('No low-power adapter, trying force fallback...');
      adapter = await navigator.gpu.requestAdapter({
        forceFallbackAdapter: true,
      });
    }

    if (!adapter) {
      throw new Error(
        'Failed to get GPU adapter. WebGPU may not be fully enabled.\n' +
        'For Firefox on Linux: Set dom.webgpu.enabled=true AND gfx.webgpu.force-enabled=true in about:config'
      );
    }

    console.log('GPU Adapter:', adapter.info || 'info not available');

    this.device = await adapter.requestDevice();
    this.context = this.canvas.getContext('webgpu');

    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: 'premultiplied',
    });

    await this.createPipelines();
    this.initialized = true;

    return true;
  }

  /**
   * Create compute and render pipelines
   */
  async createPipelines() {
    // Load shaders
    const computeShaderCode = await fetch('./shaders/compute.wgsl').then((r) =>
      r.text()
    );
    const renderShaderCode = await fetch('./shaders/render.wgsl').then((r) =>
      r.text()
    );

    const computeModule = this.device.createShaderModule({
      label: 'N-Body Compute Shader',
      code: computeShaderCode,
    });

    // Check for shader compilation errors
    const computeInfo = await computeModule.getCompilationInfo();
    if (computeInfo.messages.length > 0) {
      console.error('Compute shader compilation messages:');
      for (const msg of computeInfo.messages) {
        console.error(`  ${msg.type}: ${msg.message} (line ${msg.lineNum}, col ${msg.linePos})`);
      }
    }

    const renderModule = this.device.createShaderModule({
      label: 'N-Body Render Shader',
      code: renderShaderCode,
    });

    // Check for shader compilation errors
    const renderInfo = await renderModule.getCompilationInfo();
    if (renderInfo.messages.length > 0) {
      console.error('Render shader compilation messages:');
      for (const msg of renderInfo.messages) {
        console.error(`  ${msg.type}: ${msg.message} (line ${msg.lineNum}, col ${msg.linePos})`);
      }
    }

    // Compute pipeline
    this.computePipeline = this.device.createComputePipeline({
      label: 'N-Body Compute Pipeline',
      layout: 'auto',
      compute: {
        module: computeModule,
        entryPoint: 'main',
      },
    });

    // Render pipeline
    this.renderPipeline = this.device.createRenderPipeline({
      label: 'N-Body Render Pipeline',
      layout: 'auto',
      vertex: {
        module: renderModule,
        entryPoint: 'vertexMain',
      },
      fragment: {
        module: renderModule,
        entryPoint: 'fragmentMain',
        targets: [
          {
            format: this.format,
            blend: {
              color: {
                srcFactor: 'src-alpha',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add',
              },
              alpha: {
                srcFactor: 'one',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add',
              },
            },
          },
        ],
      },
      primitive: {
        topology: 'triangle-strip',
      },
    });

    // Trail pipeline for line rendering
    const trailShaderCode = `
      struct Camera {
        viewProj: mat4x4<f32>,
        eye: vec3<f32>,
        _padding: f32,
      }

      struct TrailParams {
        trailLength: u32,
        trailHead: u32,
        numParticles: u32,
        _padding: u32,
      }

      // Trail buffer: [particle0_pos0, particle0_pos1, ..., particle1_pos0, ...]
      // Each position is vec4 (xyz + alpha/age)
      @group(0) @binding(0) var<storage, read> trailPositions: array<vec4<f32>>;
      @group(0) @binding(1) var<uniform> camera: Camera;
      @group(0) @binding(2) var<uniform> trailParams: TrailParams;

      struct VertexOutput {
        @builtin(position) position: vec4<f32>,
        @location(0) alpha: f32,
      }

      @vertex
      fn vertexMain(
        @builtin(vertex_index) vertexIndex: u32,
        @builtin(instance_index) instanceIndex: u32
      ) -> VertexOutput {
        let particleIdx = instanceIndex / (trailParams.trailLength - 1u);
        let segmentIdx = instanceIndex % (trailParams.trailLength - 1u);
        let isEnd = vertexIndex;  // 0 = start, 1 = end of segment

        // Calculate indices in ring buffer
        // Start from (trailHead + 1) which is the OLDEST position
        // trailHead points to the last written (newest) position
        let idx0 = (trailParams.trailHead + 1u + segmentIdx) % trailParams.trailLength;
        let idx1 = (trailParams.trailHead + 1u + segmentIdx + 1u) % trailParams.trailLength;

        let bufferIdx0 = particleIdx * trailParams.trailLength + idx0;
        let bufferIdx1 = particleIdx * trailParams.trailLength + idx1;

        let pos0 = trailPositions[bufferIdx0];
        let pos1 = trailPositions[bufferIdx1];

        // Check if BOTH endpoints are valid - if either is invalid, skip this segment
        let bothValid = pos0.w * pos1.w;

        let pos = select(pos0, pos1, isEnd == 1u);

        // Age-based alpha (newer = more opaque, older = more transparent)
        // segmentIdx 0 is oldest, segmentIdx (trailLength-2) is newest
        let normalizedAge = f32(segmentIdx) / f32(trailParams.trailLength - 1u);
        let alpha = normalizedAge * 0.8 * bothValid;

        var output: VertexOutput;
        output.position = camera.viewProj * vec4<f32>(pos.xyz, 1.0);
        output.alpha = alpha;
        return output;
      }

      @fragment
      fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
        if (input.alpha < 0.01) {
          discard;
        }
        return vec4<f32>(0.5, 0.7, 1.0, input.alpha);
      }
    `;

    const trailModule = this.device.createShaderModule({
      label: 'Trail Shader',
      code: trailShaderCode,
    });

    this.trailPipeline = this.device.createRenderPipeline({
      label: 'Trail Pipeline',
      layout: 'auto',
      vertex: {
        module: trailModule,
        entryPoint: 'vertexMain',
      },
      fragment: {
        module: trailModule,
        entryPoint: 'fragmentMain',
        targets: [
          {
            format: this.format,
            blend: {
              color: {
                srcFactor: 'src-alpha',
                dstFactor: 'one',
                operation: 'add',
              },
              alpha: {
                srcFactor: 'one',
                dstFactor: 'one',
                operation: 'add',
              },
            },
          },
        ],
      },
      primitive: {
        topology: 'line-list',
      },
    });

    // Trail update compute shader - copies positions from particle buffer to trail buffer
    const trailUpdateShaderCode = `
      struct Particle {
        position: vec3<f32>,
        mass: f32,
        velocity: vec3<f32>,
        _padding: f32,
        acceleration: vec3<f32>,
        _padding2: f32,
        k2: vec3<f32>,
        _padding3: f32,
        k3: vec3<f32>,
        _padding4: f32,
        origPosition: vec3<f32>,
        _padding5: f32,
        origVelocity: vec3<f32>,
        _padding6: f32,
      }

      struct TrailParams {
        trailLength: u32,
        trailHead: u32,
        numParticles: u32,
        _padding: u32,
      }

      @group(0) @binding(0) var<storage, read> particles: array<Particle>;
      @group(0) @binding(1) var<storage, read_write> trailPositions: array<vec4<f32>>;
      @group(0) @binding(2) var<uniform> trailParams: TrailParams;

      @compute @workgroup_size(256)
      fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
        let idx = global_id.x;
        if (idx >= trailParams.numParticles) {
          return;
        }

        // Write current position to trail buffer at head position
        let trailIdx = idx * trailParams.trailLength + trailParams.trailHead;
        trailPositions[trailIdx] = vec4<f32>(particles[idx].position, 1.0);
      }
    `;

    const trailUpdateModule = this.device.createShaderModule({
      label: 'Trail Update Shader',
      code: trailUpdateShaderCode,
    });

    this.trailUpdatePipeline = this.device.createComputePipeline({
      label: 'Trail Update Pipeline',
      layout: 'auto',
      compute: {
        module: trailUpdateModule,
        entryPoint: 'main',
      },
    });
  }

  /**
   * Initialize particle buffers with simulation data
   * @param {Float32Array} particleData - Particle data array
   * @param {Object} simParams - Simulation parameters {dt, G, softening}
   */
  initializeBuffers(particleData, simParams) {
    this.numParticles = particleData.length / 28;  // 28 floats per particle (with RK4 storage)
    this.integrator = simParams.integrator || 'verlet';  // Default to verlet

    // Create particle buffers (double buffered)
    for (let i = 0; i < 2; i++) {
      this.particleBuffers[i] = this.device.createBuffer({
        label: `Particle Buffer ${i}`,
        size: particleData.byteLength,
        usage:
          GPUBufferUsage.STORAGE |
          GPUBufferUsage.COPY_DST |
          GPUBufferUsage.COPY_SRC,
      });
    }

    // Upload initial data to buffer 0 only
    // Buffer 1 will be written by the first compute pass
    this.device.queue.writeBuffer(this.particleBuffers[0], 0, particleData);

    // Simulation parameters buffer
    // Layout: dt(f32), G(f32), softening(f32), numParticles(u32), phase(u32), method(u32), padding(u32x2)
    // Total: 32 bytes (8 x 4)
    this.paramsBuffer = this.device.createBuffer({
      label: 'Simulation Parameters',
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });

    const paramsMapping = this.paramsBuffer.getMappedRange();
    const floatView = new Float32Array(paramsMapping);
    const uintView = new Uint32Array(paramsMapping);
    floatView[0] = simParams.dt;
    floatView[1] = simParams.G;
    floatView[2] = simParams.softening;
    uintView[3] = this.numParticles;
    uintView[4] = 0;   // phase (initially 0)
    uintView[5] = this.getMethodCode(this.integrator);  // method
    uintView[6] = 0;   // padding
    uintView[7] = 0;   // padding
    this.paramsBuffer.unmap();

    // Camera buffer (4x4 matrix + vec3 + padding = 64 + 16 = 80 bytes)
    this.cameraBuffer = this.device.createBuffer({
      label: 'Camera',
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Trail buffer: stores trailLength positions (vec4) per particle
    // vec4 = xyz position + w (validity flag, 0 = invalid, 1 = valid)
    const trailBufferSize = this.numParticles * this.trailLength * 4 * 4; // 4 floats * 4 bytes
    this.trailBuffer = this.device.createBuffer({
      label: 'Trail Buffer',
      size: trailBufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Initialize trail buffer with zeros (invalid positions)
    const trailInitData = new Float32Array(this.numParticles * this.trailLength * 4);
    this.device.queue.writeBuffer(this.trailBuffer, 0, trailInitData);

    // Trail params buffer
    this.trailParamsBuffer = this.device.createBuffer({
      label: 'Trail Params',
      size: 16, // 4 u32s
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.trailHead = 0;
    this.currentBuffer = 0;  // Must be set before createBindGroups
    this.createBindGroups();
  }

  /**
   * Create bind groups for compute and render passes
   */
  createBindGroups() {
    // Compute bind groups (ping-pong)
    for (let i = 0; i < 2; i++) {
      this.computeBindGroups[i] = this.device.createBindGroup({
        label: `Compute Bind Group ${i}`,
        layout: this.computePipeline.getBindGroupLayout(0),
        entries: [
          {
            binding: 0,
            resource: { buffer: this.particleBuffers[i] },
          },
          {
            binding: 1,
            resource: { buffer: this.particleBuffers[1 - i] },
          },
          {
            binding: 2,
            resource: { buffer: this.paramsBuffer },
          },
        ],
      });
    }

    // Trail bind group for rendering
    this.trailBindGroup = this.device.createBindGroup({
      label: 'Trail Bind Group',
      layout: this.trailPipeline.getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: { buffer: this.trailBuffer },
        },
        {
          binding: 1,
          resource: { buffer: this.cameraBuffer },
        },
        {
          binding: 2,
          resource: { buffer: this.trailParamsBuffer },
        },
      ],
    });

    // Trail update bind groups (one per particle buffer for ping-pong)
    for (let i = 0; i < 2; i++) {
      this.trailUpdateBindGroups[i] = this.device.createBindGroup({
        label: `Trail Update Bind Group ${i}`,
        layout: this.trailUpdatePipeline.getBindGroupLayout(0),
        entries: [
          {
            binding: 0,
            resource: { buffer: this.particleBuffers[i] },
          },
          {
            binding: 1,
            resource: { buffer: this.trailBuffer },
          },
          {
            binding: 2,
            resource: { buffer: this.trailParamsBuffer },
          },
        ],
      });
    }
  }

  /**
   * Update camera matrices
   * @param {Float32Array} viewProjMatrix - 4x4 view-projection matrix
   * @param {Array} eyePosition - Camera position [x, y, z]
   */
  updateCamera(viewProjMatrix, eyePosition) {
    if (!this.cameraBuffer) return;
    const cameraData = new Float32Array(20);
    cameraData.set(viewProjMatrix, 0);
    cameraData.set(eyePosition, 16);
    this.device.queue.writeBuffer(this.cameraBuffer, 0, cameraData);
  }

  /**
   * Update simulation parameters
   * @param {Object} params - {dt, G, softening}
   */
  updateParams(params) {
    if (!this.paramsBuffer) return;
    const paramsData = new Float32Array([params.dt, params.G, params.softening]);
    this.device.queue.writeBuffer(this.paramsBuffer, 0, paramsData);
  }

  /**
   * Get numeric method code for integrator name
   */
  getMethodCode(name) {
    const methods = { euler: 0, leapfrog: 1, verlet: 2, rk4: 3 };
    return methods[name] || 2;  // Default to verlet
  }

  /**
   * Get number of passes required for integrator
   */
  getPassCount() {
    const passCounts = { euler: 1, leapfrog: 2, verlet: 2, rk4: 4 };
    return passCounts[this.integrator] || 2;
  }

  /**
   * Set integration method
   * @param {string} integrator - 'euler', 'leapfrog', 'verlet', or 'rk4'
   */
  setIntegrator(integrator) {
    this.integrator = integrator;
    if (!this.paramsBuffer) return;
    const methodData = new Uint32Array([this.getMethodCode(integrator)]);
    this.device.queue.writeBuffer(this.paramsBuffer, 20, methodData);  // offset 20 = method
  }

  /**
   * Run compute pass to advance simulation
   * Number of passes depends on integration method
   */
  runComputePass() {
    const workgroupCount = Math.ceil(this.numParticles / 256);
    const numPasses = this.getPassCount();

    for (let phase = 0; phase < numPasses; phase++) {
      // Set phase
      const phaseData = new Uint32Array([phase]);
      this.device.queue.writeBuffer(this.paramsBuffer, 16, phaseData);  // offset 16 = phase

      const commandEncoder = this.device.createCommandEncoder({
        label: `Compute Command Encoder - Phase ${phase}`,
      });

      const passEncoder = commandEncoder.beginComputePass({
        label: `N-Body Compute Pass - Phase ${phase}`,
      });

      passEncoder.setPipeline(this.computePipeline);
      passEncoder.setBindGroup(0, this.computeBindGroups[this.currentBuffer]);
      passEncoder.dispatchWorkgroups(workgroupCount);
      passEncoder.end();

      this.device.queue.submit([commandEncoder.finish()]);

      // Swap buffers after each pass
      this.currentBuffer = 1 - this.currentBuffer;
    }
  }

  /**
   * Enable or disable trail effect
   * @param {boolean} enabled
   */
  setTrailEnabled(enabled) {
    this.trailEnabled = enabled;
    // Clear trail buffer when disabling
    if (!enabled && this.trailBuffer) {
      const trailInitData = new Float32Array(this.numParticles * this.trailLength * 4);
      this.device.queue.writeBuffer(this.trailBuffer, 0, trailInitData);
      this.trailHead = 0;
    }
  }

  /**
   * Update trail buffer with current particle positions using GPU compute
   * Called before render when trails are enabled
   */
  updateTrail() {
    if (!this.trailEnabled || !this.trailBuffer) return;

    // Update trail params with current head position
    const trailParamsData = new Uint32Array([
      this.trailLength,
      this.trailHead,
      this.numParticles,
      0,  // padding
    ]);
    this.device.queue.writeBuffer(this.trailParamsBuffer, 0, trailParamsData);

    // Run compute pass to copy positions to trail buffer
    const commandEncoder = this.device.createCommandEncoder({
      label: 'Trail Update Command Encoder',
    });

    const passEncoder = commandEncoder.beginComputePass({
      label: 'Trail Update Compute Pass',
    });

    passEncoder.setPipeline(this.trailUpdatePipeline);
    passEncoder.setBindGroup(0, this.trailUpdateBindGroups[this.currentBuffer]);

    const workgroupCount = Math.ceil(this.numParticles / 256);
    passEncoder.dispatchWorkgroups(workgroupCount);
    passEncoder.end();

    this.device.queue.submit([commandEncoder.finish()]);

    // Advance head for next frame
    this.trailHead = (this.trailHead + 1) % this.trailLength;
  }

  /**
   * Render particles
   */
  render() {
    // Create render bind group fresh each frame to ensure correct buffer
    const renderBindGroup = this.device.createBindGroup({
      label: 'Render Bind Group',
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: { buffer: this.particleBuffers[this.currentBuffer] },
        },
        {
          binding: 1,
          resource: { buffer: this.cameraBuffer },
        },
      ],
    });

    const commandEncoder = this.device.createCommandEncoder({
      label: 'Render Command Encoder',
    });

    const textureView = this.context.getCurrentTexture().createView();

    // Clear background
    const passEncoder = commandEncoder.beginRenderPass({
      label: 'N-Body Render Pass',
      colorAttachments: [
        {
          view: textureView,
          clearValue: { r: 0.02, g: 0.02, b: 0.05, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });

    // Render trails first (behind particles)
    if (this.trailEnabled) {
      passEncoder.setPipeline(this.trailPipeline);
      passEncoder.setBindGroup(0, this.trailBindGroup);
      // Draw line segments: 2 vertices per segment, (trailLength-1) segments per particle
      const numSegments = this.numParticles * (this.trailLength - 1);
      passEncoder.draw(2, numSegments);
    }

    // Render particles on top
    passEncoder.setPipeline(this.renderPipeline);
    passEncoder.setBindGroup(0, renderBindGroup);
    passEncoder.draw(4, this.numParticles);
    passEncoder.end();

    this.device.queue.submit([commandEncoder.finish()]);
  }

  /**
   * Read back particle data from GPU (for debugging/CPU sync)
   * @returns {Promise<Float32Array>}
   */
  async readParticleData() {
    const bufferSize = this.numParticles * 28 * 4; // 28 floats per particle

    const readBuffer = this.device.createBuffer({
      size: bufferSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const commandEncoder = this.device.createCommandEncoder();
    commandEncoder.copyBufferToBuffer(
      this.particleBuffers[this.currentBuffer],
      0,
      readBuffer,
      0,
      bufferSize
    );
    this.device.queue.submit([commandEncoder.finish()]);

    await readBuffer.mapAsync(GPUMapMode.READ);
    const data = new Float32Array(readBuffer.getMappedRange().slice(0));
    readBuffer.unmap();
    readBuffer.destroy();

    return data;
  }

  /**
   * Clean up GPU resources
   */
  destroy() {
    if (this.particleBuffers[0]) this.particleBuffers[0].destroy();
    if (this.particleBuffers[1]) this.particleBuffers[1].destroy();
    if (this.paramsBuffer) this.paramsBuffer.destroy();
    if (this.cameraBuffer) this.cameraBuffer.destroy();
  }
}

/**
 * Simple camera controller for 3D navigation
 */
export class Camera {
  constructor() {
    this.distance = 5;
    this.theta = 0; // Azimuth angle
    this.phi = Math.PI / 4; // Elevation angle
    this.target = [0, 0, 0];
    this.fov = Math.PI / 4;
    this.near = 0.1;
    this.far = 1000;
    this.aspect = 1;
  }

  /**
   * Orbit camera around target
   * @param {number} deltaTheta - Horizontal rotation delta
   * @param {number} deltaPhi - Vertical rotation delta
   */
  orbit(deltaTheta, deltaPhi) {
    this.theta += deltaTheta;
    this.phi = Math.max(0.01, Math.min(Math.PI - 0.01, this.phi + deltaPhi));
  }

  /**
   * Zoom camera
   * @param {number} delta - Zoom delta (positive = zoom in)
   */
  zoom(delta) {
    this.distance = Math.max(0.5, this.distance * (1 - delta * 0.1));
  }

  /**
   * Get camera eye position
   * @returns {Array} [x, y, z]
   */
  getEyePosition() {
    const x =
      this.target[0] +
      this.distance * Math.sin(this.phi) * Math.cos(this.theta);
    const y = this.target[1] + this.distance * Math.cos(this.phi);
    const z =
      this.target[2] +
      this.distance * Math.sin(this.phi) * Math.sin(this.theta);
    return [x, y, z];
  }

  /**
   * Get view-projection matrix
   * @returns {Float32Array} 4x4 matrix
   */
  getViewProjectionMatrix() {
    const eye = this.getEyePosition();
    const viewMatrix = this.lookAt(eye, this.target, [0, 1, 0]);
    const projMatrix = this.perspective(
      this.fov,
      this.aspect,
      this.near,
      this.far
    );
    return this.multiply(projMatrix, viewMatrix);
  }

  // Matrix utilities
  lookAt(eye, target, up) {
    const z = this.normalize([
      eye[0] - target[0],
      eye[1] - target[1],
      eye[2] - target[2],
    ]);
    const x = this.normalize(this.cross(up, z));
    const y = this.cross(z, x);

    return new Float32Array([
      x[0], y[0], z[0], 0,
      x[1], y[1], z[1], 0,
      x[2], y[2], z[2], 0,
      -this.dot(x, eye), -this.dot(y, eye), -this.dot(z, eye), 1,
    ]);
  }

  perspective(fov, aspect, near, far) {
    const f = 1 / Math.tan(fov / 2);
    const rangeInv = 1 / (near - far);

    return new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (near + far) * rangeInv, -1,
      0, 0, near * far * rangeInv * 2, 0,
    ]);
  }

  // Column-major matrix multiplication for WebGPU
  multiply(a, b) {
    const result = new Float32Array(16);
    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 4; row++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) {
          // a[row, k] * b[k, col] in column-major: a[k*4+row] * b[col*4+k]
          sum += a[k * 4 + row] * b[col * 4 + k];
        }
        result[col * 4 + row] = sum;
      }
    }
    return result;
  }

  normalize(v) {
    const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    return [v[0] / len, v[1] / len, v[2] / len];
  }

  cross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
  }

  dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }
}
