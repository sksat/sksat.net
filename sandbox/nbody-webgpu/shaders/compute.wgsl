// N-Body Gravity Compute Shader
// Supports multiple integration methods:
// - Euler (1st order): method=0
// - Leapfrog (2nd order symplectic): method=1
// - Velocity Verlet (2nd order symplectic): method=2
// - RK4 (4th order): method=3

struct Particle {
    position: vec3<f32>,
    mass: f32,
    velocity: vec3<f32>,
    _padding: f32,
    acceleration: vec3<f32>,  // Current/stored acceleration (k1 for RK4)
    _padding2: f32,
    // For RK4: store k2, k3 values and original state
    k2: vec3<f32>,
    _padding3: f32,
    k3: vec3<f32>,
    _padding4: f32,
    origPosition: vec3<f32>,
    _padding5: f32,
    origVelocity: vec3<f32>,
    _padding6: f32,
}

struct SimParams {
    dt: f32,
    G: f32,
    softening: f32,
    numParticles: u32,
    phase: u32,     // 0-3 for different passes
    method: u32,    // 0=euler, 1=leapfrog, 2=verlet, 3=rk4
    _padding: vec2<u32>,
}

@group(0) @binding(0) var<storage, read> particlesIn: array<Particle>;
@group(0) @binding(1) var<storage, read_write> particlesOut: array<Particle>;
@group(0) @binding(2) var<uniform> params: SimParams;

const TILE_SIZE: u32 = 256u;

// Shared memory for tile-based optimization
var<workgroup> sharedPos: array<vec4<f32>, 256>;  // xyz = position, w = mass

// Compute gravitational acceleration at a given position
// All threads in workgroup must call this function together (uniform control flow)
fn computeAcceleration(myPos: vec3<f32>, idx: u32, localIdx: u32, isValid: bool) -> vec3<f32> {
    var acceleration = vec3<f32>(0.0, 0.0, 0.0);
    let softeningSq = params.softening * params.softening;
    let numTiles = (params.numParticles + TILE_SIZE - 1u) / TILE_SIZE;

    for (var tile: u32 = 0u; tile < numTiles; tile = tile + 1u) {
        // Load tile into shared memory
        let loadIdx = tile * TILE_SIZE + localIdx;
        if (loadIdx < params.numParticles) {
            let p = particlesIn[loadIdx];
            sharedPos[localIdx] = vec4<f32>(p.position, p.mass);
        } else {
            sharedPos[localIdx] = vec4<f32>(0.0, 0.0, 0.0, 0.0);
        }

        workgroupBarrier();

        // Compute interactions with all particles in this tile (only for valid particles)
        if (isValid) {
            for (var j: u32 = 0u; j < TILE_SIZE; j = j + 1u) {
                let globalJ = tile * TILE_SIZE + j;

                if (globalJ == idx || globalJ >= params.numParticles) {
                    continue;
                }

                let other = sharedPos[j];
                let otherPos = other.xyz;
                let otherMass = other.w;

                let r = otherPos - myPos;
                let distSq = dot(r, r) + softeningSq;
                let invDist = inverseSqrt(distSq);
                let invDist3 = invDist * invDist * invDist;

                acceleration = acceleration + params.G * otherMass * invDist3 * r;
            }
        }

        workgroupBarrier();
    }

    return acceleration;
}

@compute @workgroup_size(256)
fn main(
    @builtin(global_invocation_id) global_id: vec3<u32>,
    @builtin(local_invocation_id) local_id: vec3<u32>
) {
    let idx = global_id.x;
    let localIdx = local_id.x;
    let isValid = idx < params.numParticles;

    // Read particle data (use dummy data for out-of-bounds threads)
    var p: Particle;
    if (isValid) {
        p = particlesIn[idx];
    }
    let dt = params.dt;

    // All threads must call computeAcceleration together for barrier synchronization
    // The isValid flag ensures only valid particles accumulate results
    var acceleration = vec3<f32>(0.0, 0.0, 0.0);
    var newPosition = p.position;
    var newVelocity = p.velocity;

    // Select integration method
    // Note: params.method is uniform, so all threads take same branch
    if (params.method == 0u) {
        // ===== EULER (Semi-implicit/Symplectic) =====
        // Single pass: v += a*dt, x += v*dt
        acceleration = computeAcceleration(p.position, idx, localIdx, isValid);
        if (isValid) {
            newVelocity = p.velocity + acceleration * dt;
            newPosition = p.position + newVelocity * dt;
        }

    } else if (params.method == 1u) {
        // ===== LEAPFROG (Kick-Drift-Kick) =====
        if (params.phase == 0u) {
            // Phase 0: Half kick + drift
            acceleration = computeAcceleration(p.position, idx, localIdx, isValid);
            if (isValid) {
                let vHalf = p.velocity + 0.5 * acceleration * dt;
                newPosition = p.position + vHalf * dt;
                newVelocity = vHalf;  // Store half-step velocity temporarily
            }
        } else {
            // Phase 1: Final half kick
            acceleration = computeAcceleration(p.position, idx, localIdx, isValid);
            if (isValid) {
                newVelocity = p.velocity + 0.5 * acceleration * dt;
            }
        }

    } else if (params.method == 2u) {
        // ===== VELOCITY VERLET =====
        if (params.phase == 0u) {
            // Phase 0: Position update
            acceleration = computeAcceleration(p.position, idx, localIdx, isValid);
            if (isValid) {
                newPosition = p.position + p.velocity * dt + 0.5 * acceleration * dt * dt;
            }
        } else {
            // Phase 1: Velocity update
            let oldAcceleration = p.acceleration;
            acceleration = computeAcceleration(p.position, idx, localIdx, isValid);
            if (isValid) {
                newVelocity = p.velocity + 0.5 * (oldAcceleration + acceleration) * dt;
            }
        }

    } else if (params.method == 3u) {
        // ===== RK4 (4th order Runge-Kutta) =====
        if (params.phase == 0u) {
            // Phase 0: Compute k1, store original state, advance to x1
            acceleration = computeAcceleration(p.position, idx, localIdx, isValid);
            if (isValid) {
                // x1 = x + 0.5*dt*v, v1 = v + 0.5*dt*k1
                newPosition = p.position + 0.5 * dt * p.velocity;
                newVelocity = p.velocity + 0.5 * dt * acceleration;
                // Store original state
                p.origPosition = p.position;
                p.origVelocity = p.velocity;
            }
        } else if (params.phase == 1u) {
            // Phase 1: Compute k2, advance to x2
            acceleration = computeAcceleration(p.position, idx, localIdx, isValid);
            if (isValid) {
                newPosition = p.origPosition + 0.5 * dt * p.velocity;
                newVelocity = p.origVelocity + 0.5 * dt * acceleration;
                p.k2 = acceleration;
            }
        } else if (params.phase == 2u) {
            // Phase 2: Compute k3, advance to x3
            acceleration = computeAcceleration(p.position, idx, localIdx, isValid);
            if (isValid) {
                newPosition = p.origPosition + dt * p.velocity;
                newVelocity = p.origVelocity + dt * acceleration;
                p.k3 = acceleration;
            }
        } else {
            // Phase 3: Compute k4, final integration
            let k4 = computeAcceleration(p.position, idx, localIdx, isValid);
            if (isValid) {
                let k1 = p.acceleration;
                let k2 = p.k2;
                let k3 = p.k3;

                // Final velocity: v_new = v_orig + dt/6*(k1 + 2*k2 + 2*k3 + k4)
                newVelocity = p.origVelocity + (dt / 6.0) * (k1 + 2.0 * k2 + 2.0 * k3 + k4);

                // Final position using velocity averaging
                let v0 = p.origVelocity;
                let v1 = p.origVelocity + 0.5 * dt * k1;
                let v2 = p.origVelocity + 0.5 * dt * k2;
                let v3 = p.origVelocity + dt * k3;
                newPosition = p.origPosition + (dt / 6.0) * (v0 + 2.0 * v1 + 2.0 * v2 + v3);

                acceleration = k4;
            }
        }
    }

    // Write output only for valid particles
    if (isValid) {
        var out = p;
        out.position = newPosition;
        out.velocity = newVelocity;
        out.acceleration = acceleration;
        particlesOut[idx] = out;
    }
}
