"use client";
import { useEffect, useRef } from "react";
import type { MeshPhongMaterial } from "three";
import type { LivePulse } from "@/lib/types";

// Aesthetic fallback when we haven't received any geocoded pulses yet.
// The arcs below always use this set so the globe never looks empty.
const SEED_CITIES: { lat: number; lng: number }[] = [
  { lat: 37.57, lng: 126.98 }, { lat: 35.68, lng: 139.65 },
  { lat: 31.22, lng: 121.46 }, { lat: 12.97, lng: 77.59 },
  { lat: 32.09, lng: 34.78 }, { lat: 52.52, lng: 13.41 },
  { lat: 51.51, lng: -0.13 }, { lat: 48.86, lng: 2.35 },
  { lat: 40.71, lng: -74.01 }, { lat: 37.77, lng: -122.42 },
  { lat: -23.55, lng: -46.63 }, { lat: -33.87, lng: 151.21 },
  { lat: 6.52, lng: 3.38 }, { lat: -1.29, lng: 36.82 },
  { lat: 43.65, lng: -79.38 }, { lat: 19.43, lng: -99.13 },
];

const COUNTRIES_URL =
  "https://cdn.jsdelivr.net/gh/janarosmonaliev/github-globe@master/src/files/globe-data-min.json";
const PULSE_WINDOW_MS = 25_000; // show pulses from the last 25 seconds
const LABEL_WINDOW_MS = 3_000; // labels flash for 3s — long enough to read, short enough to not pile up

type CountryFeature = { type: string; properties: Record<string, unknown>; geometry: unknown };

type Props = {
  pulses: LivePulse[];
};

export function Globe({ pulses }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // three-globe types are loaded via dynamic import, so keep the ref untyped.
  // biome-ignore lint/suspicious/noExplicitAny: three-globe's default export is a class with no public type export
  const globeRef = useRef<any>(null);

  // one-time scene setup
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;

    (async () => {
      const el = containerRef.current;
      if (!el) return;
      if (el.offsetWidth === 0 || el.offsetHeight === 0) return;

      const THREE = await import("three");
      const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");
      const ThreeGlobeModule = await import("three-globe");
      const ThreeGlobe = ThreeGlobeModule.default;
      if (disposed) return;

      // deterministic arcs between SEED cities (decorative)
      let seed = 7;
      const rand = () => {
        seed = (seed * 9301 + 49297) % 233280;
        return seed / 233280;
      };
      const arcs: { startLat: number; startLng: number; endLat: number; endLng: number; initialGap: number }[] = [];
      for (let i = 0; i < 34; i++) {
        const a = SEED_CITIES[Math.floor(rand() * SEED_CITIES.length)];
        let b = SEED_CITIES[Math.floor(rand() * SEED_CITIES.length)];
        while (b === a) b = SEED_CITIES[Math.floor(rand() * SEED_CITIES.length)];
        arcs.push({
          startLat: a.lat,
          startLng: a.lng,
          endLat: b.lat,
          endLng: b.lng,
          initialGap: rand() * 3,
        });
      }

      const globe = new ThreeGlobe({ waitForGlobeReady: true, animateIn: true })
        .hexPolygonResolution(3)
        .hexPolygonMargin(0.3)
        .hexPolygonColor(() => "rgba(210,215,230,0.38)")
        .showAtmosphere(true)
        .atmosphereColor("#fbbf24")
        .atmosphereAltitude(0.22)
        // rings and points start with the seed set — the effect below replaces them
        // with live geocoded pulses as they arrive.
        .ringsData(SEED_CITIES)
        .ringColor(() => (t: number) => `rgba(254,243,199,${1 - t})`)
        .ringMaxRadius(4.5)
        .ringPropagationSpeed(3)
        .ringRepeatPeriod(1600)
        .pointsData(SEED_CITIES)
        .pointColor(() => "#fff7d6")
        .pointAltitude(0.012)
        .pointRadius(0.45)
        .arcsData(arcs)
        .arcColor(() => ["rgba(251,191,36,0.02)", "rgba(254,243,199,1)", "rgba(251,191,36,0.02)"])
        .arcDashLength(0.38)
        .arcDashGap(3.2)
        .arcDashInitialGap((d) => (d as { initialGap: number }).initialGap)
        .arcDashAnimateTime(2200)
        .arcStroke(0.28)
        .arcAltitudeAutoScale(0.5)
        .labelsData([])
        .labelLat((d) => (d as LivePulse).lat)
        .labelLng((d) => (d as LivePulse).lng)
        .labelText((d) => (d as LivePulse).repo)
        .labelSize(0.38)
        .labelDotRadius(0)
        .labelColor(() => "rgba(254,243,199,0.95)")
        .labelResolution(2)
        .labelAltitude(0.015);

      const mat = globe.globeMaterial() as MeshPhongMaterial;
      mat.color = new THREE.Color(0x13131a);
      mat.emissive = new THREE.Color(0x080810);
      mat.emissiveIntensity = 0.1;
      mat.shininess = 0.6;

      const scene = new THREE.Scene();
      scene.add(globe);
      scene.add(new THREE.AmbientLight(0xffffff, 0.6));
      const dirLight = new THREE.DirectionalLight(0xffffff, 0.75);
      dirLight.position.set(-400, 1200, 300);
      scene.add(dirLight);
      const amberLight = new THREE.DirectionalLight(0xfbbf24, 0.5);
      amberLight.position.set(-200, 300, 200);
      scene.add(amberLight);

      const camera = new THREE.PerspectiveCamera(
        50,
        Math.max(el.offsetWidth, 1) / Math.max(el.offsetHeight, 1),
        1,
        2000,
      );
      camera.position.z = 400;

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(el.offsetWidth, el.offsetHeight);
      renderer.setClearColor(0x000000, 0);
      el.appendChild(renderer.domElement);

      globe.rotation.y = -Math.PI / 3;

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.enablePan = false;
      controls.enableZoom = true;
      controls.minDistance = 250;
      controls.maxDistance = 600;
      controls.autoRotate = true;
      controls.autoRotateSpeed = 0.35;
      controls.rotateSpeed = 0.6;

      let raf = 0;
      const animate = () => {
        controls.update();
        renderer.render(scene, camera);
        raf = requestAnimationFrame(animate);
      };
      animate();

      const resize = () => {
        if (!el) return;
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        if (w === 0 || h === 0) return;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
      };
      window.addEventListener("resize", resize);

      fetch(COUNTRIES_URL)
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { features: CountryFeature[] } | null) => {
          if (d && d.features && !disposed) {
            globe.hexPolygonsData(d.features);
          }
        })
        .catch((err) => console.warn("globe hex data load failed:", err));

      globeRef.current = globe;

      cleanup = () => {
        cancelAnimationFrame(raf);
        window.removeEventListener("resize", resize);
        controls.dispose();
        if (renderer.domElement.parentNode === el) el.removeChild(renderer.domElement);
        renderer.dispose();
        globeRef.current = null;
      };
    })();

    return () => {
      disposed = true;
      if (cleanup) cleanup();
    };
  }, []);

  // keep rings/points in sync with live pulses
  useEffect(() => {
    const globe = globeRef.current;
    if (!globe) return;
    const now = Date.now();
    const live = pulses.filter((p) => now - p.at <= PULSE_WINDOW_MS);
    const data = live.length > 0 ? live : SEED_CITIES;
    globe.ringsData(data).pointsData(data);
  }, [pulses]);

  // repo labels: short TTL, dedupe so the same repo doesn't stack in one spot.
  // Re-filtered on an interval so stale labels drop off even during quiet moments.
  useEffect(() => {
    const globe = globeRef.current;
    if (!globe) return;
    const applyLabels = () => {
      const now = Date.now();
      const byRepo = new Map<string, LivePulse>();
      for (const p of pulses) {
        if (now - p.at > LABEL_WINDOW_MS) continue;
        const prev = byRepo.get(p.repo);
        if (!prev || p.at > prev.at) byRepo.set(p.repo, p);
      }
      globe.labelsData(Array.from(byRepo.values()));
    };
    applyLabels();
    const id = setInterval(applyLabels, 500);
    return () => clearInterval(id);
  }, [pulses]);

  return (
    <section className="relative border-r border-line overflow-hidden hidden lg:block w-[28.57%] shrink-0">
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at 50% 50%, rgba(251,191,36,0.05) 0%, transparent 60%)",
        }}
      />
      <div ref={containerRef} className="absolute inset-0" />
      <div className="absolute top-3 left-5 z-10 font-mono text-[10px] uppercase tracking-[0.18em] text-muted/70 pointer-events-none">
        {pulses.length > 0
          ? `${pulses.filter((p) => Date.now() - p.at <= PULSE_WINDOW_MS).length} live pulses`
          : "warming up…"}
      </div>
      <div className="absolute bottom-3 left-5 right-5 z-10 font-mono text-[10px] text-muted/50 pointer-events-none">
        drag to rotate · scroll to zoom
      </div>
    </section>
  );
}
