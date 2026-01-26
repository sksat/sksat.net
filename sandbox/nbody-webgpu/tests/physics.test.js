/**
 * Physics Tests for N-Body Simulation (TDD - Test First)
 */

import { createTestRunner, assert } from './test-runner.js';
import { Vector3, Particle, NBodySimulation } from '../simulation.js';

export const { runner, describe, it, beforeEach, afterEach } = createTestRunner();

// Vector3 Tests
describe('Vector3', () => {
  it('should create a zero vector by default', () => {
    const v = new Vector3();
    assert.equal(v.x, 0);
    assert.equal(v.y, 0);
    assert.equal(v.z, 0);
  });

  it('should create a vector with given values', () => {
    const v = new Vector3(1, 2, 3);
    assert.equal(v.x, 1);
    assert.equal(v.y, 2);
    assert.equal(v.z, 3);
  });

  it('should add vectors correctly', () => {
    const v1 = new Vector3(1, 2, 3);
    const v2 = new Vector3(4, 5, 6);
    const result = v1.add(v2);
    assert.equal(result.x, 5);
    assert.equal(result.y, 7);
    assert.equal(result.z, 9);
  });

  it('should subtract vectors correctly', () => {
    const v1 = new Vector3(5, 7, 9);
    const v2 = new Vector3(1, 2, 3);
    const result = v1.sub(v2);
    assert.equal(result.x, 4);
    assert.equal(result.y, 5);
    assert.equal(result.z, 6);
  });

  it('should scale vector correctly', () => {
    const v = new Vector3(1, 2, 3);
    const result = v.scale(2);
    assert.equal(result.x, 2);
    assert.equal(result.y, 4);
    assert.equal(result.z, 6);
  });

  it('should calculate length correctly', () => {
    const v = new Vector3(3, 4, 0);
    assert.equal(v.length(), 5);
  });

  it('should calculate length squared correctly', () => {
    const v = new Vector3(3, 4, 0);
    assert.equal(v.lengthSq(), 25);
  });

  it('should normalize correctly', () => {
    const v = new Vector3(3, 4, 0);
    const n = v.normalize();
    assert.approximately(n.length(), 1.0, 1e-10);
    assert.approximately(n.x, 0.6, 1e-10);
    assert.approximately(n.y, 0.8, 1e-10);
    assert.equal(n.z, 0);
  });

  it('should return zero vector when normalizing zero vector', () => {
    const v = new Vector3(0, 0, 0);
    const n = v.normalize();
    assert.equal(n.x, 0);
    assert.equal(n.y, 0);
    assert.equal(n.z, 0);
  });

  it('should calculate dot product correctly', () => {
    const v1 = new Vector3(1, 2, 3);
    const v2 = new Vector3(4, 5, 6);
    assert.equal(v1.dot(v2), 32); // 1*4 + 2*5 + 3*6 = 32
  });

  it('should calculate cross product correctly', () => {
    const v1 = new Vector3(1, 0, 0);
    const v2 = new Vector3(0, 1, 0);
    const result = v1.cross(v2);
    assert.equal(result.x, 0);
    assert.equal(result.y, 0);
    assert.equal(result.z, 1);
  });
});

// Particle Tests
describe('Particle', () => {
  it('should create a particle with position, velocity, and mass', () => {
    const pos = new Vector3(1, 2, 3);
    const vel = new Vector3(0.1, 0.2, 0.3);
    const mass = 10;
    const p = new Particle(pos, vel, mass);

    assert.equal(p.position.x, 1);
    assert.equal(p.position.y, 2);
    assert.equal(p.position.z, 3);
    assert.equal(p.velocity.x, 0.1);
    assert.equal(p.velocity.y, 0.2);
    assert.equal(p.velocity.z, 0.3);
    assert.equal(p.mass, 10);
  });
});

// NBodySimulation Tests
describe('NBodySimulation - Gravity Calculation', () => {
  let sim;

  beforeEach(() => {
    sim = new NBodySimulation({ G: 1, softening: 0, dt: 0.01 });
  });

  it('should compute zero acceleration for single particle', () => {
    sim.particles = [new Particle(new Vector3(0, 0, 0), new Vector3(), 1)];
    const acc = sim.computeTotalAcceleration(0);
    assert.equal(acc.x, 0);
    assert.equal(acc.y, 0);
    assert.equal(acc.z, 0);
  });

  it('should compute correct acceleration between two particles', () => {
    sim.particles = [
      new Particle(new Vector3(0, 0, 0), new Vector3(), 1),
      new Particle(new Vector3(1, 0, 0), new Vector3(), 1),
    ];

    const acc = sim.computeTotalAcceleration(0);
    // F = G*m1*m2/r^2 = 1*1*1/1 = 1, a = F/m = 1
    // Direction: towards particle 1, so +x
    assert.approximately(acc.x, 1.0, 1e-10);
    assert.equal(acc.y, 0);
    assert.equal(acc.z, 0);
  });

  it('should obey inverse square law', () => {
    sim.particles = [
      new Particle(new Vector3(0, 0, 0), new Vector3(), 1),
      new Particle(new Vector3(2, 0, 0), new Vector3(), 1),
    ];

    const acc = sim.computeTotalAcceleration(0);
    // r=2, so a = G*m/r^2 = 1/4 = 0.25
    assert.approximately(acc.x, 0.25, 1e-10);
  });

  it('should scale with mass', () => {
    sim.particles = [
      new Particle(new Vector3(0, 0, 0), new Vector3(), 1),
      new Particle(new Vector3(1, 0, 0), new Vector3(), 4),
    ];

    const acc = sim.computeTotalAcceleration(0);
    // a = G*m_other/r^2 = 1*4/1 = 4
    assert.approximately(acc.x, 4.0, 1e-10);
  });

  it('should combine accelerations from multiple particles', () => {
    sim.particles = [
      new Particle(new Vector3(0, 0, 0), new Vector3(), 1),
      new Particle(new Vector3(1, 0, 0), new Vector3(), 1),
      new Particle(new Vector3(-1, 0, 0), new Vector3(), 1),
    ];

    const acc = sim.computeTotalAcceleration(0);
    // Symmetric: forces cancel out
    assert.approximately(acc.x, 0, 1e-10);
  });

  it('should use softening to prevent singularity', () => {
    const simSoft = new NBodySimulation({ G: 1, softening: 0.1, dt: 0.01 });
    simSoft.particles = [
      new Particle(new Vector3(0, 0, 0), new Vector3(), 1),
      new Particle(new Vector3(0.001, 0, 0), new Vector3(), 1),
    ];

    // Without softening this would blow up, with softening it stays finite
    const acc = simSoft.computeTotalAcceleration(0);
    assert.true(isFinite(acc.x), 'Acceleration should be finite with softening');
    assert.true(Math.abs(acc.x) < 1000, 'Acceleration should be bounded');
  });
});

describe('NBodySimulation - Time Integration', () => {
  let sim;

  beforeEach(() => {
    sim = new NBodySimulation({ G: 1, softening: 0.01, dt: 0.001 });
  });

  it('should update position based on velocity', () => {
    sim.particles = [
      new Particle(new Vector3(0, 0, 0), new Vector3(1, 0, 0), 1),
    ];

    sim.step();

    // Position should move in direction of velocity
    assert.true(sim.particles[0].position.x > 0);
  });

  it('should accelerate particles towards each other', () => {
    sim.particles = [
      new Particle(new Vector3(0, 0, 0), new Vector3(), 1),
      new Particle(new Vector3(1, 0, 0), new Vector3(), 1),
    ];

    const initialDistance = sim.particles[0].position.sub(sim.particles[1].position).length();

    // Run several steps
    for (let i = 0; i < 100; i++) {
      sim.step();
    }

    const finalDistance = sim.particles[0].position.sub(sim.particles[1].position).length();

    // Particles should be closer due to gravity
    assert.true(finalDistance < initialDistance, 'Particles should move closer');
  });
});

describe('NBodySimulation - Energy Conservation', () => {
  it('should approximately conserve total energy', () => {
    const sim = new NBodySimulation({ G: 1, softening: 0.01, dt: 0.0001 });

    // Two-body system with known stable orbit initial conditions
    sim.particles = [
      new Particle(new Vector3(0, 0, 0), new Vector3(0, 0, 0), 100),
      new Particle(new Vector3(1, 0, 0), new Vector3(0, 10, 0), 0.01),
    ];

    const initialEnergy = sim.computeTotalEnergy().total;

    // Run for many steps
    for (let i = 0; i < 1000; i++) {
      sim.step();
    }

    const finalEnergy = sim.computeTotalEnergy().total;

    // Energy should be conserved within 5% (Euler method has some drift)
    const relativeError = Math.abs((finalEnergy - initialEnergy) / initialEnergy);
    assert.true(
      relativeError < 0.05,
      `Energy drift too large: ${(relativeError * 100).toFixed(2)}%`
    );
  });
});

describe('NBodySimulation - Initial Conditions', () => {
  it('should generate random cluster with correct particle count', () => {
    const particles = NBodySimulation.generateRandomCluster(100, 1, [1, 10]);
    assert.equal(particles.length, 100);
  });

  it('should generate particles within specified radius', () => {
    const radius = 5;
    const particles = NBodySimulation.generateRandomCluster(50, radius, [1, 1]);

    for (const p of particles) {
      assert.true(
        p.position.length() <= radius * 1.01, // Small tolerance for floating point
        'Particle should be within radius'
      );
    }
  });

  it('should generate particles with mass in specified range', () => {
    const minMass = 1;
    const maxMass = 10;
    const particles = NBodySimulation.generateRandomCluster(50, 1, [minMass, maxMass]);

    for (const p of particles) {
      assert.true(p.mass >= minMass, 'Mass should be >= minMass');
      assert.true(p.mass <= maxMass, 'Mass should be <= maxMass');
    }
  });
});
