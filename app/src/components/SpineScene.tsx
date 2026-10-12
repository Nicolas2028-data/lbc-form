// ホーム画面の背骨 3D アニメーション: 文字・数字なし、骨だけをゆっくり Y 軸回転
// three.js は重いので lazy import。reduced-motion では静止 1 枚のみ描画
import { useEffect, useRef } from 'react';
import type * as THREE from 'three';

export default function SpineScene() {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    let cleanup = () => {};

    void import('three').then((THREE) => {
      if (disposed) return;
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.shadowMap.enabled = false;
      el.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);

      // ライト: 白の環境光 + 緑のキーライト + 柔らかいフィルライト
      scene.add(new THREE.AmbientLight(0xf5f7f2, 1.2));
      const keyLight = new THREE.PointLight(0x2d6a4f, 80, 40);
      keyLight.position.set(-5, 6, 6);
      scene.add(keyLight);
      const fillLight = new THREE.PointLight(0x74c69d, 40, 30);
      fillLight.position.set(5, -2, 4);
      scene.add(fillLight);
      const rimLight = new THREE.PointLight(0xd8f3dc, 20, 20);
      rimLight.position.set(0, 10, -5);
      scene.add(rimLight);

      // 骨の素材: オフホワイト + 少し粗い表面
      const boneMat = new THREE.MeshStandardMaterial({
        color: new THREE.Color('#f0ede8'),
        roughness: 0.72,
        metalness: 0.0,
      });
      const discMat = new THREE.MeshStandardMaterial({
        color: new THREE.Color('#d8e8dc'),
        roughness: 0.85,
        metalness: 0.0,
      });

      // 背骨グループ(Y 軸回転用)
      const spine = new THREE.Group();
      scene.add(spine);

      // 椎骨の定義: [頸椎×7, 胸椎×12, 腰椎×5]
      // 各椎骨: radius(本体), height, zOffset(S カーブ)
      const segments: { r: number; h: number; z: number }[] = [];
      for (let i = 0; i < 7; i++) {
        // 頸椎: 小さく、前方(+z)にカーブ
        const t = i / 6;
        segments.push({ r: 0.18 + t * 0.04, h: 0.30, z: 0.5 - t * 0.8 });
      }
      for (let i = 0; i < 12; i++) {
        // 胸椎: 中程度、後方(-z)にカーブ
        const t = i / 11;
        segments.push({ r: 0.22 + t * 0.06, h: 0.32, z: -0.3 - Math.sin(t * Math.PI) * 0.55 });
      }
      for (let i = 0; i < 5; i++) {
        // 腰椎: 大きく、前方(+z)にカーブ
        const t = i / 4;
        segments.push({ r: 0.30 + t * 0.04, h: 0.36, z: -0.1 + t * 0.55 });
      }

      const totalH = segments.reduce((s, seg) => s + seg.h + 0.12, 0);
      let y = totalH / 2;

      segments.forEach((seg) => {
        y -= seg.h / 2;

        // 椎体(本体の円柱)
        const bodyGeo = new THREE.CylinderGeometry(seg.r, seg.r * 1.05, seg.h, 16);
        const body = new THREE.Mesh(bodyGeo, boneMat);
        body.position.set(0, y, seg.z);
        spine.add(body);

        // 横突起(左右の小さな突起)
        const procR = seg.r * 0.22;
        const procL = seg.r * 1.2 + procR;
        const procGeo = new THREE.CylinderGeometry(procR, procR * 0.8, procL, 8);
        const left = new THREE.Mesh(procGeo, boneMat);
        left.rotation.z = Math.PI / 2;
        left.position.set(procL / 2 + seg.r * 0.05, y, seg.z - seg.r * 0.3);
        spine.add(left);
        const right = new THREE.Mesh(procGeo, boneMat);
        right.rotation.z = Math.PI / 2;
        right.position.set(-(procL / 2 + seg.r * 0.05), y, seg.z - seg.r * 0.3);
        spine.add(right);

        // 棘突起(後方の突起)
        const spineProcGeo = new THREE.CylinderGeometry(procR * 0.8, procR, seg.r * 1.6, 8);
        const spinousProc = new THREE.Mesh(spineProcGeo, boneMat);
        spinousProc.rotation.x = Math.PI / 2;
        spinousProc.position.set(0, y, seg.z - seg.r - seg.r * 0.8);
        spine.add(spinousProc);

        // 椎間板
        y -= seg.h / 2;
        const discH = 0.10;
        const discGeo = new THREE.CylinderGeometry(seg.r * 1.08, seg.r * 1.08, discH, 16);
        const disc = new THREE.Mesh(discGeo, discMat);
        disc.position.set(0, y - discH / 2, seg.z);
        spine.add(disc);
        y -= discH + 0.02;
      });

      // 仙骨(下端の楕円形ブロック)
      const sacGeo = new THREE.CylinderGeometry(0.38, 0.28, 0.5, 16);
      const sacrum = new THREE.Mesh(sacGeo, boneMat);
      sacrum.position.set(0, y - 0.25, 0.3);
      spine.add(sacrum);

      // カメラ設定
      const resize = () => {
        const w = el.clientWidth, h = el.clientHeight;
        renderer.setSize(w, h, false);
        camera.aspect = w / Math.max(h, 1);
        const dist = w < 480 ? 18 : w < 768 ? 15 : 13;
        camera.position.set(0, 0, dist);
        camera.lookAt(0, 0, 0);
        camera.updateProjectionMatrix();
      };
      const ro = new ResizeObserver(resize);
      ro.observe(el);
      resize();

      // マウス/タッチで少しだけ傾く
      let tx = 0, ty = 0;
      const onMove = (e: PointerEvent) => {
        const r = el.getBoundingClientRect();
        tx = ((e.clientX - r.left) / r.width - 0.5) * 0.4;
        ty = ((e.clientY - r.top) / r.height - 0.5) * 0.2;
      };
      el.addEventListener('pointermove', onMove);

      let raf = 0;
      let visible = true;
      const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; });
      io.observe(el);

      // 静止画
      if (reduce) {
        spine.rotation.y = 0.4;
        renderer.render(scene, camera);
      } else {
        const tick = (now: number) => {
          raf = requestAnimationFrame(tick);
          if (!visible || document.hidden) return;
          const t = now / 1000;
          spine.rotation.y += 0.005 + (tx * 0.8 - spine.rotation.y * 0.1) * 0.04;
          spine.rotation.x += (ty * 0.3 - spine.rotation.x) * 0.03;
          // ゆっくり浮き沈み
          spine.position.y = Math.sin(t * 0.4) * 0.08;
          renderer.render(scene, camera);
        };
        raf = requestAnimationFrame(tick);
      }

      cleanup = () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        io.disconnect();
        el.removeEventListener('pointermove', onMove);
        boneMat.dispose();
        discMat.dispose();
        scene.traverse((o) => {
          const m = o as THREE.Mesh;
          m.geometry?.dispose?.();
        });
        renderer.dispose();
        renderer.domElement.remove();
      };
    });

    return () => { disposed = true; cleanup(); };
  }, []);

  return <div ref={host} className="hero-scene" aria-hidden />;
}
