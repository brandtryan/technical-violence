/* eslint-disable no-unused-vars */
// @ts-nocheck
import React, { useState, useEffect, useRef, useMemo } from "react";
import {
	AlertTriangle,
	Activity,
	CheckCircle,
	Search,
	Zap,
	PauseCircle,
	PlayCircle,
	ChevronDown,
	ChevronUp,
} from "lucide-react";

// --- SHARED SHADER NOISE LOGIC ---
const noiseSource = `
// Simplex 3D Noise function (ashima)
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x*34.0)+1.0)*x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2  C = vec2(1.0/6.0, 1.0/3.0) ;
  const vec4  D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy) );
  vec3 x0 = v - i + dot(i, C.xxx) ;
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min( g.xyz, l.zxy );
  vec3 i2 = max( g.xyz, l.zxy );
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i); 
  vec4 p = permute( permute( permute( i.z + vec4(0.0, i1.z, i2.z, 1.0 )) + i.y + vec4(0.0, i1.y, i2.y, 1.0 )) + i.x + vec4(0.0, i1.x, i2.x, 1.0 ));
  float n_ = 0.14285714285714285714;
  vec3  ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_ );
  vec4 x = x_ *ns.x + ns.yyyy;
  vec4 y = y_ *ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4( x.xy, y.xy );
  vec4 b1 = vec4( x.zw, y.zw );
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy ;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww ;
  vec3 p0 = vec3(a0.xy,h.x);
  vec3 p1 = vec3(a0.zw,h.y);
  vec3 p2 = vec3(a1.xy,h.z);
  vec3 p3 = vec3(a1.zw,h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2, p2), dot(p3,p3)));
  p0 *= norm.x;  p1 *= norm.y;  p2 *= norm.z;  p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot( m*m, vec4( dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3) ) );
}
`;

// --- RIGHT SIDE: D2V SHADERS (Transform Feedback) ---
const d2vVs = `#version 300 es
precision highp float;
in vec4 a_state;
out vec4 v_state;
out vec3 v_color;
uniform float u_time;
uniform vec2 u_mouse;
uniform float u_pointSize;
${noiseSource}
void main() {
    vec2 pos = a_state.xy;
    vec2 vel = a_state.zw;
    float dt = 0.016;
    vec2 dir = u_mouse - pos;
    float dist = length(dir);
    vec2 force = normalize(dir) * (0.02 / max(dist, 0.1));
    vec2 centerDir = pos;
    float centerDist = length(centerDir);
    force += normalize(centerDir) * (0.005 / max(centerDist, 0.05));
    vec3 noiseCoords = vec3(pos * 1.2, u_time * 0.15);
    vec2 noise = vec2(snoise(noiseCoords), snoise(noiseCoords + vec3(100.0)));
    vel = (vel + (force + noise * 0.03) * dt) * 0.985;
    pos += vel * dt;
    if (abs(pos.x) > 1.05) { pos.x *= -0.95; vel.x *= -0.5; }
    if (abs(pos.y) > 1.05) { pos.y *= -0.95; vel.y *= -0.5; }
    v_state = vec4(pos, vel);
    float speed = length(vel);
    // Darkened the base colors slightly so massive overlapping doesn't wash out instantly
    vec3 col1 = vec3(0.0, 0.05, 0.15);
    vec3 col2 = vec3(0.0, 0.8, 1.0); 
    vec3 col3 = vec3(1.0, 0.8, 0.1); 
    v_color = mix(col1, mix(col2, col3, clamp((speed * 15.0) - 0.5, 0.0, 1.0)), clamp(speed * 15.0, 0.0, 1.0));
    gl_Position = vec4(pos, 0.0, 1.0);
    gl_PointSize = u_pointSize;
}
`;
const d2vFs = `#version 300 es
precision mediump float;
in vec3 v_color;
uniform float u_alpha;
out vec4 fragColor;
void main() { fragColor = vec4(v_color, u_alpha); }
`;

// --- LEFT SIDE: LEGACY GPGPU SHADERS (FBO Ping Pong) ---
const fboPhysicsVs = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
    v_uv = a_pos * 0.5 + 0.5;
    gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;
const fboPhysicsFs = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_time;
uniform vec2 u_mouse;
out vec4 fragColor;
${noiseSource}
void main() {
    vec4 state = texture(u_tex, v_uv);
    vec2 pos = state.xy;
    vec2 vel = state.zw;
    float dt = 0.016;
    vec2 dir = u_mouse - pos;
    float dist = length(dir);
    vec2 force = normalize(dir) * (0.02 / max(dist, 0.1));
    vec2 centerDir = pos;
    float centerDist = length(centerDir);
    force += normalize(centerDir) * (0.005 / max(centerDist, 0.05));
    vec3 noiseCoords = vec3(pos * 1.2, u_time * 0.15);
    vec2 noise = vec2(snoise(noiseCoords), snoise(noiseCoords + vec3(100.0)));
    vel = (vel + (force + noise * 0.03) * dt) * 0.985;
    pos += vel * dt;
    if (abs(pos.x) > 1.05) { pos.x *= -0.95; vel.x *= -0.5; }
    if (abs(pos.y) > 1.05) { pos.y *= -0.95; vel.y *= -0.5; }
    fragColor = vec4(pos, vel);
}
`;
const legacyRenderVs = `#version 300 es
in vec4 a_state;
out vec3 v_color;
void main() {
    vec2 pos = a_state.xy;
    vec2 vel = a_state.zw;
    float speed = length(vel);
    // Red/Orange spectrum to differentiate from the right side visually
    vec3 col1 = vec3(0.1, 0.0, 0.0);
    vec3 col2 = vec3(0.9, 0.1, 0.0); 
    vec3 col3 = vec3(1.0, 0.8, 0.1); 
    v_color = mix(col1, mix(col2, col3, clamp((speed * 15.0) - 0.5, 0.0, 1.0)), clamp(speed * 15.0, 0.0, 1.0));
    gl_Position = vec4(pos, 0.0, 1.0);
    gl_PointSize = 2.5;
}
`;
const legacyRenderFs = `#version 300 es
precision mediump float;
in vec3 v_color;
uniform float u_alpha;
out vec4 fragColor;
void main() { fragColor = vec4(v_color, u_alpha); }
`;

// --- COMPONENT: TEXT HIGHLIGHTER ---
const HighlightText = ({ text, search }) => {
	if (!search) return <>{text}</>;
	const parts = text.split(new RegExp(`(${search})`, "gi"));
	return (
		<>
			{parts.map((part, i) =>
				part.toLowerCase() === search.toLowerCase() ? (
					<mark key={i} className="bg-cyan-500 text-black px-1 rounded-sm">
						{part}
					</mark>
				) : (
					part
				),
			)}
		</>
	);
};

// --- COMPONENT: LEFT SIDE (LEGACY WEBGL FBO + readPixels BOTTLENECK) ---
const WebGLLegacyFboControl = ({ count, mousePos }) => {
	const canvasRef = useRef(null);
	const [metrics, setMetrics] = useState({ fps: 0, ms: 0, cpu: 0 });
	const [isPaused, setIsPaused] = useState(false);
	const [isChoking, setIsChoking] = useState(false);
	const isPausedRef = useRef(false);

	useEffect(() => {
		isPausedRef.current = isPaused;
	}, [isPaused]);

	useEffect(() => {
		const canvas = canvasRef.current;
		const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
		if (!gl) return;

		// WebGL2 supports FLOAT FBO attachments via this extension (crucial for old physics hacks)
		gl.getExtension("EXT_color_buffer_float");

		const compile = (type, src) => {
			const s = gl.createShader(type);
			gl.shaderSource(s, src);
			gl.compileShader(s);
			if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
			return s;
		};

		const quadVs = compile(gl.VERTEX_SHADER, fboPhysicsVs);
		const quadFs = compile(gl.FRAGMENT_SHADER, fboPhysicsFs);
		const quadProgram = gl.createProgram();
		gl.attachShader(quadProgram, quadVs);
		gl.attachShader(quadProgram, quadFs);
		gl.linkProgram(quadProgram);
		gl.deleteShader(quadVs); // Free memory immediately after link
		gl.deleteShader(quadFs);

		const renderVs = compile(gl.VERTEX_SHADER, legacyRenderVs);
		const renderFs = compile(gl.FRAGMENT_SHADER, legacyRenderFs);
		const renderProgram = gl.createProgram();
		gl.attachShader(renderProgram, renderVs);
		gl.attachShader(renderProgram, renderFs);
		gl.linkProgram(renderProgram);
		gl.deleteShader(renderVs);
		gl.deleteShader(renderFs);

		const quadLocs = {
			time: gl.getUniformLocation(quadProgram, "u_time"),
			mouse: gl.getUniformLocation(quadProgram, "u_mouse"),
			tex: gl.getUniformLocation(quadProgram, "u_tex"),
		};
		const renderLocs = {
			alpha: gl.getUniformLocation(renderProgram, "u_alpha"),
		};

		// FBO Data Prep - Packing particles into a 2D Texture
		const texSize = Math.ceil(Math.sqrt(count));
		const dataSize = texSize * texSize * 4;
		const initialData = new Float32Array(dataSize);
		for (let i = 0; i < count * 4; i += 4) {
			initialData[i] = Math.random() * 2 - 1;
			initialData[i + 1] = Math.random() * 2 - 1;
			initialData[i + 2] = (Math.random() - 0.5) * 0.1;
			initialData[i + 3] = (Math.random() - 0.5) * 0.1;
		}

		const pixelBuffer = new Float32Array(dataSize);

		const createFboTexture = data => {
			const tex = gl.createTexture();
			gl.bindTexture(gl.TEXTURE_2D, tex);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, texSize, texSize, 0, gl.RGBA, gl.FLOAT, data);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

			const fbo = gl.createFramebuffer();
			gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
			gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
			return { tex, fbo };
		};

		const fboA = createFboTexture(initialData);
		const fboB = createFboTexture(initialData);

		const quadVao = gl.createVertexArray();
		gl.bindVertexArray(quadVao);
		const quadVbo = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
		gl.enableVertexAttribArray(0);
		gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

		const particleVao = gl.createVertexArray();
		gl.bindVertexArray(particleVao);
		const particleVbo = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, particleVbo);
		gl.bufferData(gl.ARRAY_BUFFER, initialData, gl.DYNAMIC_DRAW);
		gl.enableVertexAttribArray(0);
		gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);

		gl.enable(gl.BLEND);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE);

		let isUnmounted = false;
		let readFbo = fboA;
		let writeFbo = fboB;
		let frameId;
		let lastTime = performance.now();
		let frames = 0;
		let lastFpsUpdate = lastTime;

		const resize = () => {
			canvas.width = canvas.clientWidth;
			canvas.height = canvas.clientHeight;
		};
		resize();
		window.addEventListener("resize", resize);

		const animate = t => {
			if (isUnmounted) return;
			const now = performance.now();
			let syncMs = 0;

			if (!isPausedRef.current) {
				// PASS 1: GPGPU PHYSICS (Math runs entirely on GPU)
				gl.bindFramebuffer(gl.FRAMEBUFFER, writeFbo.fbo);
				gl.viewport(0, 0, texSize, texSize);
				gl.useProgram(quadProgram);
				gl.uniform1f(quadLocs.time, t * 0.001);

				// Fixed mouse mapping to properly track the left half of the screen!
				const mx = (mousePos.current.x / (window.innerWidth / 2)) * 2 - 1;
				const my = (1 - mousePos.current.y / window.innerHeight) * 2 - 1;
				gl.uniform2f(quadLocs.mouse, mx, my);

				gl.activeTexture(gl.TEXTURE0);
				gl.bindTexture(gl.TEXTURE_2D, readFbo.tex);
				gl.uniform1i(quadLocs.tex, 0);
				gl.bindVertexArray(quadVao);
				gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

				// PASS 2: THE FATAL BOTTLENECK (Extracting data from GPU back to CPU to update Vertex Buffer)
				const startSync = performance.now();
				gl.readPixels(0, 0, texSize, texSize, gl.RGBA, gl.FLOAT, pixelBuffer);

				gl.bindBuffer(gl.ARRAY_BUFFER, particleVbo);
				// Changed to bufferSubData to prevent VRAM reallocation / GC thrashing
				gl.bufferSubData(gl.ARRAY_BUFFER, 0, pixelBuffer);
				syncMs = performance.now() - startSync; // This time is pure thread-blocking lockup.
			}

			// PASS 3: RENDER TO CANVAS
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
			gl.viewport(0, 0, canvas.width, canvas.height);
			gl.clearColor(0.05, 0.02, 0.02, 1);
			gl.clear(gl.COLOR_BUFFER_BIT);
			gl.useProgram(renderProgram);
			const alpha = count >= 100000 ? 0.08 : count >= 50000 ? 0.2 : 0.6;
			gl.uniform1f(renderLocs.alpha, alpha);

			gl.bindVertexArray(particleVao);
			gl.drawArrays(gl.POINTS, 0, count);

			if (!isPausedRef.current) {
				let temp = readFbo;
				readFbo = writeFbo;
				writeFbo = temp;
			}

			frames++;
			if (now - lastFpsUpdate >= 500) {
				const fps = Math.round((frames * 1000) / (now - lastFpsUpdate));
				// CPU Stress is roughly how much of the 16.6ms frame budget was stolen by the sync block
				const estimatedCpu = isPausedRef.current ? 0 : Math.min(100, Math.round((syncMs / 16.66) * 100));
				setMetrics({ fps, ms: syncMs.toFixed(1), cpu: estimatedCpu });
				setIsChoking(estimatedCpu >= 85 && !isPausedRef.current);
				frames = 0;
				lastFpsUpdate = now;
			}

			frameId = requestAnimationFrame(animate);
		};

		frameId = requestAnimationFrame(animate);

		return () => {
			isUnmounted = true;
			cancelAnimationFrame(frameId);
			window.removeEventListener("resize", resize);
			gl.deleteBuffer(quadVbo);
			gl.deleteBuffer(particleVbo);
			gl.deleteVertexArray(quadVao);
			gl.deleteVertexArray(particleVao);
			gl.deleteTexture(fboA.tex);
			gl.deleteTexture(fboB.tex);
			gl.deleteFramebuffer(fboA.fbo);
			gl.deleteFramebuffer(fboB.fbo);
			gl.deleteProgram(quadProgram);
			gl.deleteProgram(renderProgram);
		};
	}, [count, mousePos]);

	return (
		<div className="relative w-full h-full overflow-hidden bg-black border-r border-red-900/50">
			<canvas ref={canvasRef} className="absolute inset-0 z-0 w-full h-full block" />

			<div className="absolute top-24 left-6 z-10 p-4 bg-black/80 border border-red-500/30 backdrop-blur-sm rounded-lg max-w-sm pointer-events-auto">
				<h2 className="text-red-400 font-bold text-xl flex items-center mb-2">
					<Activity className="w-5 h-5 mr-2" />
					Legacy WebGL (GPGPU)
				</h2>
				<p className="text-gray-400 text-sm mb-4 leading-relaxed">
					The true Apples-to-Apples control. Math runs on the GPU via FBO textures, but updating the vertex
					buffer forces a <code className="text-red-300">gl.readPixels()</code> pipeline stall, completely
					locking the CPU.
				</p>

				<div className="grid grid-cols-2 gap-4 mb-4">
					<div className="bg-red-950/30 p-2 rounded border border-red-900/50">
						<div className="text-xs text-red-500/70 uppercase">Particles</div>
						<div className="text-xl font-mono text-red-400">{count.toLocaleString()}</div>
					</div>
					<div className="bg-red-950/30 p-2 rounded border border-red-900/50">
						<div className="text-xs text-red-500/70 uppercase">FPS</div>
						<div className="text-xl font-mono text-red-400">{metrics.fps}</div>
					</div>
					<div className="bg-red-950/30 p-2 rounded border border-red-900/50">
						<div className="text-xs text-red-500/70 uppercase">GPU Sync Stall</div>
						<div className="text-xl font-mono text-red-400">{metrics.ms}ms</div>
					</div>
					<div className="bg-red-950/30 p-2 rounded border border-red-900/50">
						<div className="text-xs text-red-500/70 uppercase">CPU Blocked</div>
						<div className="text-xl font-mono text-red-400 flex items-center">
							{metrics.cpu}%
							{metrics.cpu > 80 && <AlertTriangle className="w-4 h-4 ml-2 text-red-500 animate-pulse" />}
						</div>
					</div>
				</div>

				<div className="flex gap-2 mt-4">
					<button
						onClick={() => setIsPaused(!isPaused)}
						className={`flex-1 py-2 px-3 rounded flex items-center justify-center text-sm font-bold transition-colors ${isPaused ? "bg-green-600 hover:bg-green-500 text-white" : "bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-600"}`}>
						{isPaused ? <PlayCircle className="w-4 h-4 mr-2" /> : <PauseCircle className="w-4 h-4 mr-2" />}
						{isPaused ? "Resume Sync" : "Halt gl.readPixels"}
					</button>
				</div>
			</div>

			{/* Warning Overlay */}
			<div className="absolute bottom-28 left-6 z-20 flex flex-col items-start pointer-events-none">
				{isChoking && (
					<div className="bg-red-900/80 border border-red-500 text-white px-4 py-2 rounded animate-pulse font-mono text-sm text-left shadow-[0_0_20px_rgba(220,38,38,0.5)]">
						SYNC BOTTLENECK REACHED.
						<br />
						Click 'Halt gl.readPixels' above to recover.
					</div>
				)}
			</div>
		</div>
	);
};

// --- COMPONENT: D2V SIMULATOR (RIGHT SIDE) ---
const WebGLD2VControl = ({ count, mousePos }) => {
	const canvasRef = useRef(null);
	const [metrics, setMetrics] = useState({ fps: 0, ms: 0 });

	useEffect(() => {
		const canvas = canvasRef.current;
		const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
		if (!gl) return;

		// Compile Shaders
		const compile = (type, src) => {
			const s = gl.createShader(type);
			gl.shaderSource(s, src);
			gl.compileShader(s);
			if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
			return s;
		};

		const vs = compile(gl.VERTEX_SHADER, d2vVs);
		const fs = compile(gl.FRAGMENT_SHADER, d2vFs);
		const program = gl.createProgram();
		gl.attachShader(program, vs);
		gl.attachShader(program, fs);
		gl.transformFeedbackVaryings(program, ["v_state"], gl.INTERLEAVED_ATTRIBS);
		gl.linkProgram(program);
		gl.deleteShader(vs); // Free memory immediately
		gl.deleteShader(fs);

		const locs = {
			time: gl.getUniformLocation(program, "u_time"),
			mouse: gl.getUniformLocation(program, "u_mouse"),
			alpha: gl.getUniformLocation(program, "u_alpha"),
			pointSize: gl.getUniformLocation(program, "u_pointSize"),
		};

		// Generate Initial SoA Data
		const data = new Float32Array(count * 4);
		for (let i = 0; i < data.length; i += 4) {
			data[i] = Math.random() * 2 - 1;
			data[i + 1] = Math.random() * 2 - 1;
			data[i + 2] = (Math.random() - 0.5) * 0.1;
			data[i + 3] = (Math.random() - 0.5) * 0.1;
		}

		// Setup Ping-Pong Buffers
		const setupVao = buffer => {
			const vao = gl.createVertexArray();
			gl.bindVertexArray(vao);
			gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
			gl.enableVertexAttribArray(0);
			gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
			return vao;
		};

		const bufA = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, bufA);
		gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_COPY);
		const vaoA = setupVao(bufA);

		const bufB = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, bufB);
		gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_COPY);
		const vaoB = setupVao(bufB);

		gl.bindVertexArray(null);
		gl.bindBuffer(gl.ARRAY_BUFFER, null);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE);

		let isUnmounted = false;
		let readIdx = 0;
		let frameId;
		let lastTime = performance.now();
		let frames = 0;
		let lastFpsUpdate = lastTime;

		const resize = () => {
			canvas.width = canvas.clientWidth;
			canvas.height = canvas.clientHeight;
			gl.viewport(0, 0, canvas.width, canvas.height);
		};
		resize();
		window.addEventListener("resize", resize);

		const animate = t => {
			if (isUnmounted) return;
			const now = performance.now();
			const startGpu = performance.now();
			const writeIdx = 1 - readIdx;

			gl.useProgram(program);
			gl.uniform1f(locs.time, t * 0.001);

			// Dynamic alpha: 8-bit buffer limit means anything below 0.004 (1/255) rounds to 0 and becomes invisible!
			// We set the absolute floor to 0.004 for 5M and 10M to ensure they render as a brilliant glowing core.
			const alpha =
				count >= 10000000
					? 0.004
					: count >= 5000000
						? 0.008
						: count >= 1000000
							? 0.02
							: count >= 100000
								? 0.15
								: 0.4;
			gl.uniform1f(locs.alpha, alpha);

			// Clamping point size to minimum 1.0, as most GPUs ignore sub-pixel point drawing requests anyway
			const pointSize = count >= 5000000 ? 1.0 : count >= 1000000 ? 1.2 : 2.5;
			gl.uniform1f(locs.pointSize, pointSize);

			const mx = ((mousePos.current.x - window.innerWidth / 2) / (window.innerWidth / 2)) * 2 - 1;
			const my = (1 - mousePos.current.y / window.innerHeight) * 2 - 1;
			gl.uniform2f(locs.mouse, mx, my);

			const readVao = readIdx === 0 ? vaoA : vaoB;
			const writeBuf = writeIdx === 0 ? bufA : bufB;

			// Transform Feedback Pass (Zero CPU Sync!)
			gl.bindVertexArray(readVao);
			gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, writeBuf);
			gl.enable(gl.RASTERIZER_DISCARD);
			gl.beginTransformFeedback(gl.POINTS);
			gl.drawArrays(gl.POINTS, 0, count);
			gl.endTransformFeedback();
			gl.disable(gl.RASTERIZER_DISCARD);
			gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);

			// Render Pass
			gl.clearColor(0.05, 0.05, 0.05, 1);
			gl.clear(gl.COLOR_BUFFER_BIT);
			gl.bindVertexArray(writeIdx === 0 ? vaoA : vaoB);
			gl.drawArrays(gl.POINTS, 0, count);

			readIdx = writeIdx;

			const cpuTime = performance.now() - startGpu;
			frames++;
			if (now - lastFpsUpdate >= 500) {
				setMetrics({
					fps: Math.round((frames * 1000) / (now - lastFpsUpdate)),
					ms: cpuTime.toFixed(2),
				});
				frames = 0;
				lastFpsUpdate = now;
			}

			frameId = requestAnimationFrame(animate);
		};

		frameId = requestAnimationFrame(animate);

		return () => {
			isUnmounted = true;
			cancelAnimationFrame(frameId);
			window.removeEventListener("resize", resize);
			gl.deleteBuffer(bufA);
			gl.deleteBuffer(bufB);
			gl.deleteVertexArray(vaoA);
			gl.deleteVertexArray(vaoB);
			gl.deleteProgram(program);
		};
	}, [count, mousePos]);

	return (
		<div className="relative w-full h-full bg-[#0d0d0d]">
			<canvas ref={canvasRef} className="w-full h-full block" />

			<div className="absolute top-24 right-6 z-10 p-4 bg-black/80 border border-cyan-500/30 backdrop-blur-sm rounded-lg max-w-sm pointer-events-auto">
				<h2 className="text-cyan-400 font-bold text-xl flex items-center mb-2">
					<Zap className="w-5 h-5 mr-2" />
					Direct-to-Vertex (D2V)
				</h2>
				<p className="text-gray-400 text-sm mb-4 leading-relaxed">
					Structure of Arrays (SoA) + Transform Feedback. Physics calculate entirely in VRAM. Data stays on
					the GPU. Zero CPU Sync block.
				</p>

				<div className="grid grid-cols-2 gap-4 mb-4">
					<div className="bg-cyan-950/30 p-2 rounded border border-cyan-900/50">
						<div className="text-xs text-cyan-500/70 uppercase">Particles</div>
						<div className="text-xl font-mono text-cyan-400">{count.toLocaleString()}</div>
					</div>
					<div className="bg-cyan-950/30 p-2 rounded border border-cyan-900/50">
						<div className="text-xs text-cyan-500/70 uppercase">FPS</div>
						<div className="text-xl font-mono text-cyan-400">{metrics.fps}</div>
					</div>
					<div className="bg-cyan-950/30 p-2 rounded border border-cyan-900/50">
						<div className="text-xs text-cyan-500/70 uppercase">GPU Sync Stall</div>
						<div className="text-xl font-mono text-cyan-400">{metrics.ms}ms</div>
					</div>
					<div className="bg-cyan-950/30 p-2 rounded border border-cyan-900/50">
						<div className="text-xs text-cyan-500/70 uppercase">CPU Blocked</div>
						<div className="text-xl font-mono text-cyan-400 flex items-center">
							0% <CheckCircle className="w-4 h-4 ml-2 text-green-500" />
						</div>
					</div>
				</div>
			</div>
		</div>
	);
};

// --- MAIN APPLICATION LAYOUT ---
export default function App() {
	const [leftCount, setLeftCount] = useState(1000);
	const [rightCount, setRightCount] = useState(1000);

	const mousePos = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
	const [searchText, setSearchText] = useState("");
	const [showInstructions, setShowInstructions] = useState(false);
	const [hasClickedStart, setHasClickedStart] = useState(false);

	useEffect(() => {
		const handleMouseMove = e => {
			mousePos.current = { x: e.clientX, y: e.clientY };
		};
		window.addEventListener("mousemove", handleMouseMove);
		return () => window.removeEventListener("mousemove", handleMouseMove);
	}, []);

	return (
		<div className="w-screen h-screen flex flex-col font-sans overflow-hidden bg-black text-white selection:bg-cyan-500/30">
			{/* Header */}
			<header className="absolute top-0 w-full z-50 flex items-center justify-between p-4 pointer-events-none">
				<div className="bg-black/80 border border-gray-800 px-4 py-2 rounded-full backdrop-blur pointer-events-auto">
					<h1 className="font-bold tracking-wider uppercase text-sm">
						Direct-to-Vertex (D2V) Paradigm <span className="text-gray-500 font-mono ml-2">vs</span> The
						Sync Bottleneck
					</h1>
				</div>

				{/* Semantic Kill Proof: Search Box */}
				<div className="flex items-center space-x-2 bg-black/80 border border-gray-800 px-4 py-2 rounded-full backdrop-blur pointer-events-auto">
					<Search className="w-4 h-4 text-cyan-500" />
					<input
						type="text"
						placeholder="Search this page..."
						value={searchText}
						onChange={e => setSearchText(e.target.value)}
						className="bg-transparent border-none outline-none text-sm text-white w-48 placeholder-gray-500 focus:ring-0"
					/>
				</div>
			</header>

			{/* Instructions Dropdown */}
			<div className="absolute top-24 left-[420px] z-40 flex flex-col items-start pointer-events-auto">
				<button
					onClick={() => {
						setShowInstructions(!showInstructions);
						setHasClickedStart(true);
					}}
					className={`bg-black/95 border border-cyan-500 text-cyan-400 font-bold px-5 py-2 rounded-t-lg flex items-center hover:bg-cyan-950 transition-colors tracking-wider ${!hasClickedStart ? "animate-pulse shadow-[0_0_25px_rgba(6,182,212,0.6)]" : "shadow-[0_0_15px_rgba(6,182,212,0.2)]"}`}>
					START HERE{" "}
					{showInstructions ? (
						<ChevronUp className="w-5 h-5 ml-2" />
					) : (
						<ChevronDown className="w-5 h-5 ml-2" />
					)}
				</button>

				{showInstructions && (
					<div className="bg-black/95 border border-cyan-500/50 backdrop-blur-xl p-6 rounded-b-xl rounded-tr-xl shadow-2xl w-[400px]">
						<h3 className="text-lg font-bold text-white mb-2">The "Apples to Apples" Lab</h3>
						<p className="text-gray-400 mb-4 text-[13px] leading-relaxed">
							Both sides calculate physics on the GPU. The only difference is Architecture.
							<br />
							<br />
							<strong className="text-cyan-400 font-medium">Crucial Observation:</strong> Because standard
							web architecture forces everything to share the exact same single-threaded Event Loop, the
							frame rate is always bound by the slowest component. Even with a powerful GPU rendering
							millions of particles effortlessly on the right, the crippling `gl.readPixels()` sync stall
							on the left will drag the <em>entire tab</em> down to its lower FPS.
						</p>
						<ol className="list-decimal list-outside pl-8 pr-4 py-4 space-y-2.5 text-gray-300 font-mono text-[11px] bg-gray-950/80 rounded border border-gray-800 shadow-inner leading-relaxed">
							<li>
								Click <span className="text-red-400 font-bold">200K</span> or{" "}
								<span className="text-red-400 font-bold">500K</span> on the left side (Legacy WebGL
								API).
							</li>
							<li>
								Wait for the CPU to choke on the sync block{" "}
								<span className="text-red-500">("Sync Bottleneck" alert)</span>.
							</li>
							<li>
								Click <span className="text-gray-400 font-bold">Halt gl.readPixels</span>.
							</li>
							<li>
								Click <span className="text-cyan-400 font-bold">5M</span> or{" "}
								<span className="text-cyan-400 font-bold">10M</span> on the right side (WebGL2 D2V API)!
							</li>
							<li>
								Interact with right side <span className="text-gray-500">(move mouse around)</span>.
							</li>
							<li>Search for "n" in Search bar above.</li>
							<li>
								To reset the simulation,{" "}
								<span className="text-gray-400 font-bold">refresh the page</span>.
							</li>
						</ol>
					</div>
				)}
			</div>

			{/* Split Screen Lab */}
			<div className="flex-1 flex w-full">
				{/* Left Side: The Problem (Legacy WebGL) */}
				<div className="w-1/2 relative group">
					<WebGLLegacyFboControl count={leftCount} mousePos={mousePos} />

					<div className="absolute bottom-10 left-6 z-20 flex gap-2 p-2 bg-black/80 backdrop-blur rounded border border-gray-800 pointer-events-auto">
						<button
							onClick={() => setLeftCount(100000)}
							className={`px-4 py-2 rounded text-sm font-mono transition-colors ${leftCount === 100000 ? "bg-red-500 text-black font-bold" : "text-red-500 hover:bg-red-950 border border-red-900"}`}>
							100K
						</button>
						<button
							onClick={() => setLeftCount(200000)}
							className={`px-4 py-2 rounded text-sm font-mono transition-colors ${leftCount === 200000 ? "bg-red-500 text-black font-bold" : "text-red-500 hover:bg-red-950 border border-red-900"}`}>
							200K
						</button>
						<button
							onClick={() => setLeftCount(500000)}
							className={`px-4 py-2 rounded text-sm font-mono transition-colors ${leftCount === 500000 ? "bg-red-500 text-black font-bold shadow-[0_0_15px_rgba(239,68,68,0.5)]" : "text-red-500 hover:bg-red-950 border border-red-900"}`}>
							500K
						</button>
					</div>
				</div>

				{/* Right Side: The Solution (WebGL D2V) */}
				<div className="w-1/2 relative">
					<WebGLD2VControl count={rightCount} mousePos={mousePos} />

					{/* "Semantic Kill" Target Overlay */}
					<div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-20 pointer-events-none">
						<div
							className={`transition-all duration-300 ${searchText ? "bg-cyan-950/40 border-cyan-400/60 shadow-[0_0_30px_rgba(6,182,212,0.2)] scale-105" : "bg-black/40 border-gray-700"} border backdrop-blur-md p-6 rounded-xl text-center shadow-2xl`}>
							<h3 className="text-xl font-light text-cyan-50 mb-2">
								<HighlightText text="I am standard HTML." search={searchText} />
							</h3>
							<p className="text-sm text-cyan-200/70 max-w-xs leading-relaxed">
								<HighlightText
									text={`Floating above a GPU simulation of ${rightCount.toLocaleString()} particles. Fully indexable, highlightable, and readable.`}
									search={searchText}
								/>
							</p>
							<p className="mt-4 font-mono text-xs text-cyan-400">
								<HighlightText text="Direct-to-Vertex" search={searchText} />
							</p>
						</div>
					</div>

					{/* Action Overlay */}
					<div className="absolute bottom-10 left-1/2 -translate-x-1/2 z-20 flex gap-2 p-2 bg-black/80 backdrop-blur rounded border border-gray-800 pointer-events-auto">
						<button
							onClick={() => setRightCount(1000)}
							className={`px-4 py-2 rounded text-sm font-mono transition-colors ${rightCount === 1000 ? "bg-cyan-500 text-black font-bold" : "text-cyan-500 hover:bg-cyan-950 border border-cyan-900"}`}>
							1K
						</button>
						<button
							onClick={() => setRightCount(1000000)}
							className={`px-4 py-2 rounded text-sm font-mono transition-colors ${rightCount === 1000000 ? "bg-cyan-500 text-black font-bold" : "text-cyan-500 hover:bg-cyan-950 border border-cyan-900"}`}>
							1M
						</button>
						<button
							onClick={() => setRightCount(5000000)}
							className={`px-4 py-2 rounded text-sm font-mono transition-colors ${rightCount === 5000000 ? "bg-cyan-500 text-black font-bold" : "text-cyan-500 hover:bg-cyan-950 border border-cyan-900"}`}>
							5M
						</button>
						<button
							onClick={() => setRightCount(10000000)}
							className={`px-4 py-2 rounded text-sm font-mono transition-colors ${rightCount === 10000000 ? "bg-cyan-500 text-black font-bold shadow-[0_0_15px_rgba(6,182,212,0.5)]" : "text-cyan-500 hover:bg-cyan-950 border border-cyan-900"}`}>
							10M
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
