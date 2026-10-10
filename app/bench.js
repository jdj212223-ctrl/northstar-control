(() => {
  "use strict";
  const api = window.northstar;
  if (!api || !api.bench) return;

  const $ = (id) => document.getElementById(id);
  const cards = Object.fromEntries([...document.querySelectorAll(".bench-card")].map((card) => [card.dataset.bench, card]));
  let busy = false;

  function toast(message) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = message;
    el.classList.add("visible");
    setTimeout(() => el.classList.remove("visible"), 3200);
  }

  function show(kind, rows, note) {
    const box = $(`bench-${kind}-result`);
    box.replaceChildren();
    rows.forEach(([label, value, unit]) => {
      const item = document.createElement("div");
      item.className = "bench-stat";
      const l = document.createElement("span"); l.textContent = label;
      const v = document.createElement("strong"); v.textContent = value;
      if (unit) { const u = document.createElement("small"); u.textContent = ` ${unit}`; v.append(u); }
      item.append(l, v);
      box.append(item);
    });
    if (note) {
      const n = document.createElement("div");
      n.className = "bench-note";
      n.textContent = note;
      box.append(n);
    }
  }

  function setProgress(kind, percent) {
    const bar = cards[kind]?.querySelector(".bench-bar i");
    if (bar) bar.style.width = `${percent}%`;
  }

  function setBusy(value, kind) {
    busy = value;
    document.querySelectorAll("[data-run], #bench-all").forEach((button) => { button.disabled = value; });
    $("bench-cancel").hidden = !value;
    Object.entries(cards).forEach(([name, card]) => card.classList.toggle("running", value && name === kind));
    if (!value) Object.keys(cards).forEach((name) => setProgress(name, 0));
  }

  // A fixed fragment-shader workload on an offscreen canvas, run on whichever GPU Chromium picked.
  async function benchGpu() {
    const canvas = document.createElement("canvas");
    canvas.width = 1024; canvas.height = 1024;
    const gl = canvas.getContext("webgl", { antialias: false, powerPreference: "high-performance", failIfMajorPerformanceCaveat: false });
    if (!gl) throw new Error("WebGL is not available on this system.");
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error("Shader failed to compile.");
      return shader;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}"));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, "precision highp float;uniform float t;void main(){vec2 u=gl_FragCoord.xy/1024.;float a=0.;for(int i=0;i<96;i++){a+=sin(u.x*float(i)+t)*cos(u.y*float(i)-t)+sqrt(abs(a)+1.);}gl_FragColor=vec4(fract(a),u,1.);}"));
    gl.linkProgram(program);
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const location = gl.getAttribLocation(program, "p");
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    const time = gl.getUniformLocation(program, "t");
    const pixel = new Uint8Array(4);
    const draw = (i) => { gl.uniform1f(time, i * 0.01); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel); };
    for (let i = 0; i < 5; i += 1) draw(i);
    const duration = 3000;
    const start = performance.now();
    let frames = 0;
    while (performance.now() - start < duration) {
      draw(frames);
      frames += 1;
      if (frames % 4 === 0) { setProgress("gpu", Math.min(100, ((performance.now() - start) / duration) * 100)); await new Promise((r) => setTimeout(r, 0)); }
    }
    const seconds = (performance.now() - start) / 1000;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : "Unknown GPU";
    const fps = frames / seconds;
    return { renderer: String(renderer), fps: Math.round(fps * 10) / 10, score: Math.round(fps * 1024 * 1024 * 96 / 1e9 * 10), software: /swiftshader|llvmpipe|software|basic render/i.test(renderer) };
  }

  async function runOne(kind) {
    setBusy(true, kind);
    setProgress(kind, 8);
    try {
      if (kind === "gpu") {
        const r = await benchGpu();
        show("gpu", [["Score", String(r.score)], ["Frames", r.fps.toFixed(1), "fps"]], r.software ? "No hardware GPU was used — this is software rendering." : `Rendered on ${r.renderer}`);
      } else {
        const request = { kind };
        if (kind === "disk") { request.volume = $("bench-volume").value; request.sizeMb = Number($("bench-size").value); }
        const response = await api.bench.run(request);
        if (!response.ok) throw new Error(response.reason === "busy" ? "A benchmark is already running." : response.reason);
        const r = response.result;
        if (kind === "cpu") show("cpu", [["Single-core", String(r.singleScore)], ["Multi-core", String(r.multiScore)], ["Scaling", `${r.scaling}×`, `on ${r.threads} threads`]]);
        if (kind === "memory") show("memory", [["Copy speed", String(r.copyGBps), "GB/s"], ["Installed", String(r.totalGB), "GB"]]);
        if (kind === "disk") show("disk", [["Write", String(r.writeMBps), "MB/s"], ["Read", String(r.readMBps), "MB/s"]], `${response.volume} · ${r.sizeMb} MB test. Read may be cached.`);
      }
      setProgress(kind, 100);
    } catch (error) {
      toast(error.message === "Cancelled." ? "Benchmark stopped." : `Benchmark failed: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  document.querySelectorAll("[data-run]").forEach((button) => button.addEventListener("click", () => { if (!busy) runOne(button.dataset.run); }));
  $("bench-all").addEventListener("click", async () => {
    if (busy) return;
    for (const kind of ["cpu", "memory", "gpu"]) await runOne(kind);
  });
  $("bench-cancel").addEventListener("click", () => api.bench.cancel());
  api.bench.onProgress(({ kind, percent }) => setProgress(kind, percent));

  async function loadTargets() {
    const select = $("bench-volume");
    try {
      const volumes = await api.bench.volumes();
      select.replaceChildren(...volumes.map((volume) => { const option = new Option(volume.label, volume.id); return option; }));
    } catch { select.replaceChildren(new Option("Drives unavailable", "")); }
    try {
      const adapters = await api.bench.gpus();
      const list = $("bench-gpu-list");
      list.replaceChildren(...adapters.map((adapter) => {
        const item = document.createElement("li");
        item.textContent = `${adapter.name || `GPU ${adapter.deviceId}`}${adapter.active ? " · active" : ""}`;
        return item;
      }));
    } catch { /* adapter list is informational */ }
    const cpu = await api.getSystemStatus().catch(() => null);
    if (cpu) $("bench-cpu-model").textContent = cpu.cpuModel;
  }

  document.querySelector('.nav-item[data-view="benchmark"]').addEventListener("click", loadTargets);
  loadTargets();
})();
