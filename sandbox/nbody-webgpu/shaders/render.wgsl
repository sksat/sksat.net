// N-Body Particle Rendering Shader
// Renders particles as billboarded point sprites with velocity-based coloring

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

struct Camera {
    viewProj: mat4x4<f32>,
    eye: vec3<f32>,
    _padding: f32,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) uv: vec2<f32>,
}

@group(0) @binding(0) var<storage, read> particles: array<Particle>;
@group(0) @binding(1) var<uniform> camera: Camera;

// Vertex shader for instanced point sprite rendering
// 4 vertices per particle (quad), particle index via instance_index
@vertex
fn vertexMain(
    @builtin(vertex_index) vertexIndex: u32,
    @builtin(instance_index) instanceIndex: u32
) -> VertexOutput {
    let particle = particles[instanceIndex];

    // Quad vertices in local space (-1 to 1)
    var quadPos: array<vec2<f32>, 4> = array<vec2<f32>, 4>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(1.0, -1.0),
        vec2<f32>(-1.0, 1.0),
        vec2<f32>(1.0, 1.0)
    );

    let localPos = quadPos[vertexIndex];

    // Transform particle position to clip space
    let worldPos = vec4<f32>(particle.position, 1.0);
    var clipPos = camera.viewProj * worldPos;

    // Determine if this is solar system (mass in solar masses) or other preset
    // Solar system: Sun mass = 1.0, planets mass ~ 1e-6 to 1e-3
    // Galaxy/other: masses typically 0.001 to 100
    let isSolarSystem = particle.mass > 0.1 || particle.mass < 0.002;

    var pointSize: f32;
    var color: vec4<f32>;

    if (isSolarSystem) {
        // === Solar System (mass in solar masses M☉) ===
        // Sun: 1.0, Jupiter: ~9.5e-4, Earth: ~3e-6, Mercury: ~1.7e-7
        if (particle.mass > 0.1) {
            // Sun
            pointSize = 0.008;
            color = vec4<f32>(1.0, 0.95, 0.4, 1.0);  // Bright yellow
        } else if (particle.mass > 5e-4) {
            // Jupiter (~9.5e-4)
            pointSize = 0.005;
            color = vec4<f32>(0.9, 0.7, 0.5, 1.0);  // Orange/tan
        } else if (particle.mass > 1.5e-4) {
            // Saturn (~2.9e-4)
            pointSize = 0.004;
            color = vec4<f32>(0.95, 0.85, 0.55, 1.0);  // Pale gold
        } else if (particle.mass > 4e-5) {
            // Neptune (~5.1e-5), Uranus (~4.4e-5)
            pointSize = 0.003;
            if (particle.mass > 4.8e-5) {
                color = vec4<f32>(0.3, 0.5, 0.9, 1.0);  // Neptune - deep blue
            } else {
                color = vec4<f32>(0.6, 0.85, 0.9, 1.0);  // Uranus - cyan
            }
        } else if (particle.mass > 2e-6) {
            // Earth (~3e-6)
            pointSize = 0.0025;
            color = vec4<f32>(0.3, 0.6, 1.0, 1.0);  // Blue
        } else if (particle.mass > 1.5e-6) {
            // Venus (~2.4e-6)
            pointSize = 0.0025;
            color = vec4<f32>(0.9, 0.8, 0.5, 1.0);  // Yellowish/tan
        } else if (particle.mass > 2e-7) {
            // Mars (~3.2e-7)
            pointSize = 0.002;
            color = vec4<f32>(0.8, 0.4, 0.3, 1.0);  // Reddish
        } else {
            // Mercury (~1.7e-7)
            pointSize = 0.0015;
            color = vec4<f32>(0.6, 0.6, 0.6, 1.0);  // Gray
        }
    } else {
        // === Galaxy / Random / Binary / Collision presets ===
        // Mass typically 0.001 to 100

        // Small point-like particles
        let baseSize = 0.001;
        pointSize = baseSize;

        // Special case for central mass in galaxy
        if (particle.mass > 10.0) {
            pointSize = 0.003;
            color = vec4<f32>(1.0, 0.9, 0.6, 1.0);  // Bright yellow core
        } else {
            // Velocity-based coloring for disk particles
            let speed = length(particle.velocity);
            let maxSpeed = 15.0;
            let normalizedSpeed = clamp(speed / maxSpeed, 0.0, 1.0);

            if (normalizedSpeed < 0.5) {
                let t = normalizedSpeed * 2.0;
                color = mix(
                    vec4<f32>(0.4, 0.5, 1.0, 1.0),   // Blue
                    vec4<f32>(0.3, 0.9, 1.0, 1.0),   // Cyan
                    t
                );
            } else {
                let t = (normalizedSpeed - 0.5) * 2.0;
                color = mix(
                    vec4<f32>(0.3, 0.9, 1.0, 1.0),   // Cyan
                    vec4<f32>(1.0, 1.0, 0.8, 1.0),   // Yellow-white
                    t
                );
            }
        }
    }

    // Apply offset in clip space (screen-aligned)
    clipPos.x = clipPos.x + localPos.x * pointSize * clipPos.w;
    clipPos.y = clipPos.y + localPos.y * pointSize * clipPos.w;

    var output: VertexOutput;
    output.position = clipPos;
    output.color = color;
    output.uv = localPos;
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    let dist = length(input.uv);

    // Discard outside circle
    if (dist > 1.0) {
        discard;
    }

    // Solid circle with anti-aliased edge
    let edgeWidth = 0.05;
    let alpha = smoothstep(1.0, 1.0 - edgeWidth, dist);

    // Slight brightness variation for depth (brighter center)
    let brightness = 0.8 + 0.2 * (1.0 - dist);

    return vec4<f32>(
        input.color.rgb * brightness,
        input.color.a * alpha
    );
}
