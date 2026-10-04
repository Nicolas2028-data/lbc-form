// ホーム画面の立体アニメーション: 直近 12 か月の売上を立体の棒にして、光の粒と一緒にゆっくり回す。
// three.js は重いので、この画面を開いたときだけ読み込む。動きを減らす設定の端末では止めた絵を 1 枚だけ描く
import { useEffect, useRef } from 'react';
import type * as THREE from 'three';

interface Props {
  values: number[];   // 古い月 → 新しい月
  accent?: string;
}

export default function HeroScene({ values, accent = '#34c58a' }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const key = values.join(',');

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    let cleanup = () => {};

    void import('three').then((THREE) => {
      if (disposed) return;
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      el.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      scene.fog = new THREE.Fog(0x05110c, 14, 34);
      const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);

      const green = new THREE.Color(accent);
      const teal = new THREE.Color('#2fb3c4');
      scene.add(new THREE.AmbientLight(0xffffff, 0.35));
      const key1 = new THREE.PointLight(green, 60, 40);
      key1.position.set(-6, 9, 6);
      scene.add(key1);
      const key2 = new THREE.PointLight(teal, 45, 40);
      key2.position.set(7, 6, -5);
      scene.add(key2);

      // 床のグリッド
      const grid = new THREE.GridHelper(40, 40, green, green);
      const gm = grid.material as THREE.Material;
      gm.transparent = true;
      gm.opacity = 0.12;
      grid.position.y = -0.01;
      scene.add(grid);

      // 売上の棒(円弧に並べる)
      const n = Math.max(values.length, 1);
      const max = Math.max(...values, 1);
      const hasData = values.some((v) => v > 0);
      const heights = values.map((v, i) => (hasData ? 0.4 + (v / max) * 5.2 : 1 + Math.sin(i / 1.6) * 0.8 + 0.8));
      const group = new THREE.Group();
      scene.add(group);
      const radius = 6.2;
      const bars: { mesh: THREE.Mesh; cap: THREE.Mesh; h: number }[] = [];
      const barGeo = new THREE.BoxGeometry(0.62, 1, 0.62);
      barGeo.translate(0, 0.5, 0);
      const capGeo = new THREE.BoxGeometry(0.66, 0.06, 0.66);
      heights.forEach((h, i) => {
        const t = n === 1 ? 0.5 : i / (n - 1);
        const ang = -Math.PI * 0.62 + t * Math.PI * 1.24;
        const color = teal.clone().lerp(green, t);
        const mat = new THREE.MeshStandardMaterial({
          color, emissive: color, emissiveIntensity: i === n - 1 ? 0.55 : 0.22,
          metalness: 0.3, roughness: 0.35, transparent: true, opacity: 0.9,
        });
        const mesh = new THREE.Mesh(barGeo, mat);
        mesh.position.set(Math.sin(ang) * radius, 0, -Math.cos(ang) * radius + 2);
        mesh.rotation.y = -ang;
        mesh.scale.y = reduce ? h : 0.001;
        group.add(mesh);
        const cap = new THREE.Mesh(capGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }));
        cap.position.copy(mesh.position);
        cap.rotation.y = mesh.rotation.y;
        cap.position.y = reduce ? h : 0;
        group.add(cap);
        bars.push({ mesh, cap, h });
      });

      // 光の輪
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(radius + 1.4, 0.015, 8, 160),
        new THREE.MeshBasicMaterial({ color: green, transparent: true, opacity: 0.45 }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.z = 2;
      group.add(ring);

      // 光の粒
      const count = 900;
      const pos = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const r = 4 + Math.random() * 13;
        const a = Math.random() * Math.PI * 2;
        pos[i * 3] = Math.cos(a) * r;
        pos[i * 3 + 1] = Math.random() * 9 - 0.5;
        pos[i * 3 + 2] = Math.sin(a) * r;
      }
      const pGeo = new THREE.BufferGeometry();
      pGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const points = new THREE.Points(pGeo, new THREE.PointsMaterial({
        color: green, size: 0.06, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      scene.add(points);

      // 画面サイズに合わせる
      const resize = () => {
        const w = el.clientWidth, h = el.clientHeight;
        renderer.setSize(w, h, false);
        camera.aspect = w / Math.max(h, 1);
        camera.position.set(0, w < 640 ? 7.5 : 6, w < 640 ? 17 : 14);
        camera.lookAt(0, 2, 0);
        camera.updateProjectionMatrix();
      };
      const ro = new ResizeObserver(resize);
      ro.observe(el);
      resize();

      // 指・マウスで少し傾く
      let tx = 0, ty = 0;
      const onMove = (e: PointerEvent) => {
        const r = el.getBoundingClientRect();
        tx = ((e.clientX - r.left) / r.width - 0.5) * 0.5;
        ty = ((e.clientY - r.top) / r.height - 0.5) * 0.25;
      };
      el.addEventListener('pointermove', onMove);

      let raf = 0;
      let visible = true;
      const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; });
      io.observe(el);
      const start = performance.now();
      const tick = (now: number) => {
        raf = requestAnimationFrame(tick);
        if (!visible || document.hidden) return;
        const s = (now - start) / 1000;
        bars.forEach((b, i) => {
          const p = Math.min(Math.max((s - i * 0.07) / 1.4, 0), 1);
          const e = 1 - Math.pow(1 - p, 3);
          const breathe = 1 + Math.sin(s * 1.2 + i * 0.6) * 0.015;
          b.mesh.scale.y = Math.max(b.h * e * breathe, 0.001);
          b.cap.position.y = b.mesh.scale.y;
        });
        group.rotation.y += (tx * 0.6 + Math.sin(s * 0.15) * 0.18 - group.rotation.y) * 0.03;
        group.rotation.x += (ty * 0.4 - group.rotation.x) * 0.03;
        points.rotation.y = s * 0.03;
        points.position.y = Math.sin(s * 0.4) * 0.15;
        ring.scale.setScalar(1 + Math.sin(s * 0.8) * 0.01);
        renderer.render(scene, camera);
      };
      if (reduce) renderer.render(scene, camera);
      else raf = requestAnimationFrame(tick);

      cleanup = () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        io.disconnect();
        el.removeEventListener('pointermove', onMove);
        scene.traverse((o) => {
          const m = o as THREE.Mesh;
          m.geometry?.dispose?.();
          const mat = m.material as THREE.Material | THREE.Material[] | undefined;
          if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose?.();
        });
        renderer.dispose();
        renderer.domElement.remove();
      };
    });

    return () => { disposed = true; cleanup(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, accent]);

  return <div ref={host} className="hero-scene" aria-hidden />;
}
