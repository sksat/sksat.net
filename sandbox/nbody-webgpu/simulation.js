/**
 * N-Body Gravity Simulation - Core Logic
 * CPU implementation with testable pure functions
 */

export class Vector3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  add(v) {
    return new Vector3(this.x + v.x, this.y + v.y, this.z + v.z);
  }

  sub(v) {
    return new Vector3(this.x - v.x, this.y - v.y, this.z - v.z);
  }

  scale(s) {
    return new Vector3(this.x * s, this.y * s, this.z * s);
  }

  length() {
    return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
  }

  lengthSq() {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }

  normalize() {
    const len = this.length();
    if (len === 0) {
      return new Vector3(0, 0, 0);
    }
    return this.scale(1 / len);
  }

  dot(v) {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }

  cross(v) {
    return new Vector3(
      this.y * v.z - this.z * v.y,
      this.z * v.x - this.x * v.z,
      this.x * v.y - this.y * v.x
    );
  }

  clone() {
    return new Vector3(this.x, this.y, this.z);
  }
}

export class Particle {
  constructor(position, velocity, mass) {
    this.position = position;
    this.velocity = velocity;
    this.mass = mass;
  }

  clone() {
    return new Particle(
      this.position.clone(),
      this.velocity.clone(),
      this.mass
    );
  }
}

export class NBodySimulation {
  constructor(params = {}) {
    this.G = params.G ?? 1;
    this.softening = params.softening ?? 0.01;
    this.dt = params.dt ?? 0.001;
    this.particles = [];
  }

  /**
   * Compute gravitational acceleration on particle i from particle j
   * @param {Particle} pi - Target particle
   * @param {Particle} pj - Source particle
   * @returns {Vector3} Acceleration vector
   */
  computeGravitationalAcceleration(pi, pj) {
    const r = pj.position.sub(pi.position);
    const distSq = r.lengthSq() + this.softening * this.softening;
    const invDist = 1 / Math.sqrt(distSq);
    const invDist3 = invDist * invDist * invDist;

    // a = G * m_j / r^2 * r_hat = G * m_j / r^3 * r
    return r.scale(this.G * pj.mass * invDist3);
  }

  /**
   * Compute total acceleration on particle at given index
   * @param {number} index - Particle index
   * @returns {Vector3} Total acceleration vector
   */
  computeTotalAcceleration(index) {
    const pi = this.particles[index];
    let acc = new Vector3();

    for (let j = 0; j < this.particles.length; j++) {
      if (j === index) continue;
      acc = acc.add(this.computeGravitationalAcceleration(pi, this.particles[j]));
    }

    return acc;
  }

  /**
   * Advance simulation by one time step using Symplectic Euler
   */
  step() {
    // Compute all accelerations first
    const accelerations = this.particles.map((_, i) =>
      this.computeTotalAcceleration(i)
    );

    // Update velocities and positions
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      // v(t+dt) = v(t) + a(t) * dt
      p.velocity = p.velocity.add(accelerations[i].scale(this.dt));
      // x(t+dt) = x(t) + v(t+dt) * dt
      p.position = p.position.add(p.velocity.scale(this.dt));
    }
  }

  /**
   * Compute total energy of the system (kinetic + potential)
   * @returns {{kinetic: number, potential: number, total: number}}
   */
  computeTotalEnergy() {
    let kinetic = 0;
    let potential = 0;

    for (let i = 0; i < this.particles.length; i++) {
      const pi = this.particles[i];

      // Kinetic energy: 0.5 * m * v^2
      kinetic += 0.5 * pi.mass * pi.velocity.lengthSq();

      // Potential energy: -G * m_i * m_j / r (sum over pairs)
      for (let j = i + 1; j < this.particles.length; j++) {
        const pj = this.particles[j];
        const r = pi.position.sub(pj.position).length();
        const rSoft = Math.sqrt(r * r + this.softening * this.softening);
        potential -= (this.G * pi.mass * pj.mass) / rSoft;
      }
    }

    return {
      kinetic,
      potential,
      total: kinetic + potential,
    };
  }

  /**
   * Convert particles to Float32Array for GPU upload
   * Layout: [px, py, pz, mass, vx, vy, vz, pad, ax, ay, az, pad2, k2x, k2y, k2z, pad3, k3x, k3y, k3z, pad4, origPx, origPy, origPz, pad5, origVx, origVy, origVz, pad6] per particle
   * Total: 28 floats per particle (for RK4 support)
   * @returns {Float32Array}
   */
  toFloat32Array() {
    const data = new Float32Array(this.particles.length * 28);

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      const offset = i * 28;
      // Position and mass
      data[offset + 0] = p.position.x;
      data[offset + 1] = p.position.y;
      data[offset + 2] = p.position.z;
      data[offset + 3] = p.mass;
      // Velocity
      data[offset + 4] = p.velocity.x;
      data[offset + 5] = p.velocity.y;
      data[offset + 6] = p.velocity.z;
      data[offset + 7] = 0;  // padding
      // Acceleration (computed by GPU)
      data[offset + 8] = 0;
      data[offset + 9] = 0;
      data[offset + 10] = 0;
      data[offset + 11] = 0; // padding2
      // k2 (for RK4)
      data[offset + 12] = 0;
      data[offset + 13] = 0;
      data[offset + 14] = 0;
      data[offset + 15] = 0; // padding3
      // k3 (for RK4)
      data[offset + 16] = 0;
      data[offset + 17] = 0;
      data[offset + 18] = 0;
      data[offset + 19] = 0; // padding4
      // Original position (for RK4)
      data[offset + 20] = 0;
      data[offset + 21] = 0;
      data[offset + 22] = 0;
      data[offset + 23] = 0; // padding5
      // Original velocity (for RK4)
      data[offset + 24] = 0;
      data[offset + 25] = 0;
      data[offset + 26] = 0;
      data[offset + 27] = 0; // padding6
    }

    return data;
  }

  /**
   * Update particles from Float32Array (after GPU compute)
   * @param {Float32Array} data
   */
  fromFloat32Array(data) {
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      const offset = i * 8;
      p.position.x = data[offset + 0];
      p.position.y = data[offset + 1];
      p.position.z = data[offset + 2];
      // mass doesn't change: data[offset + 3]
      p.velocity.x = data[offset + 4];
      p.velocity.y = data[offset + 5];
      p.velocity.z = data[offset + 6];
    }
  }

  /**
   * Generate random spherical cluster of particles
   * @param {number} n - Number of particles
   * @param {number} radius - Cluster radius
   * @param {[number, number]} massRange - [minMass, maxMass]
   * @returns {Particle[]}
   */
  static generateRandomCluster(n, radius, massRange) {
    const particles = [];

    for (let i = 0; i < n; i++) {
      // Uniform distribution in sphere using rejection sampling alternative
      const u = Math.random();
      const v = Math.random();
      const theta = 2 * Math.PI * u;
      const phi = Math.acos(2 * v - 1);
      const r = radius * Math.cbrt(Math.random()); // cbrt for uniform volume distribution

      const x = r * Math.sin(phi) * Math.cos(theta);
      const y = r * Math.sin(phi) * Math.sin(theta);
      const z = r * Math.cos(phi);

      const mass = massRange[0] + Math.random() * (massRange[1] - massRange[0]);

      particles.push(
        new Particle(new Vector3(x, y, z), new Vector3(), mass)
      );
    }

    return particles;
  }

  /**
   * Generate disk galaxy-like initial conditions
   * @param {number} n - Number of particles
   * @param {number} radius - Disk radius
   * @param {number} centralMass - Central mass (black hole/bulge)
   * @param {number} G - Gravitational constant (default 1)
   * @returns {Particle[]}
   */
  static generateGalaxy(n, radius, centralMass, G = 1) {
    const particles = [];

    // Central mass
    particles.push(
      new Particle(new Vector3(0, 0, 0), new Vector3(0, 0, 0), centralMass)
    );

    // Disk particles with circular orbital velocities
    // Galaxy is on XZ plane (Y is up)
    for (let i = 0; i < n - 1; i++) {
      const angle = Math.random() * 2 * Math.PI;
      const r = 0.1 * radius + Math.random() * 0.9 * radius;

      // Add some thickness to disk (Y direction)
      const y = (Math.random() - 0.5) * 0.1 * radius;

      const x = r * Math.cos(angle);
      const z = r * Math.sin(angle);

      // Circular orbital velocity: v = sqrt(G * M / r)
      const orbitalSpeed = Math.sqrt(G * centralMass / r);

      // Velocity perpendicular to radius vector (in XZ plane)
      const vx = -orbitalSpeed * Math.sin(angle);
      const vz = orbitalSpeed * Math.cos(angle);

      // Small random perturbation
      const perturbation = 0.1;
      const dvx = (Math.random() - 0.5) * perturbation * orbitalSpeed;
      const dvy = (Math.random() - 0.5) * perturbation * orbitalSpeed;
      const dvz = (Math.random() - 0.5) * perturbation * orbitalSpeed;

      particles.push(
        new Particle(
          new Vector3(x, y, z),
          new Vector3(vx + dvx, dvy, vz + dvz),
          0.001 // Small particle mass
        )
      );
    }

    return particles;
  }

  /**
   * Generate two-body system with circular orbit
   * @param {number} m1 - Mass of body 1
   * @param {number} m2 - Mass of body 2
   * @param {number} separation - Initial separation
   * @param {number} G - Gravitational constant (default 1)
   * @returns {Particle[]}
   */
  static generateTwoBody(m1, m2, separation, G = 1) {
    const totalMass = m1 + m2;

    // Center of mass at origin
    const r1 = -separation * m2 / totalMass;
    const r2 = separation * m1 / totalMass;

    // Orbital velocity for circular orbit: v = sqrt(G * M_total / r)
    const v = Math.sqrt(G * totalMass / separation);
    const v1 = v * m2 / totalMass;
    const v2 = -v * m1 / totalMass;

    return [
      new Particle(new Vector3(r1, 0, 0), new Vector3(0, 0, v1), m1),
      new Particle(new Vector3(r2, 0, 0), new Vector3(0, 0, v2), m2),
    ];
  }
}
