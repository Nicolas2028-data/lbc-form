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
      renderer.setClearColor(0x000000, 0);
      renderer.shadowMap.enabled = false;
      el.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);

      // ── ライティング ─────────────────────────────────────────────
      // 低めの環境光(白寄り)で潰れ防止
      scene.add(new THREE.AmbientLight(0xdff0e8, 0.7));

      // キー: DirectionalLight でシャープな陰影
      const keyDir = new THREE.DirectionalLight(0xffffff, 2.8);
      keyDir.position.set(-4, 8, 7);
      scene.add(keyDir);

      // フィル: ソフトな緑系
      const fillLight = new THREE.PointLight(0x74c69d, 60, 35);
      fillLight.position.set(6, 0, 5);
      scene.add(fillLight);

      // リム: 後方から強く当ててエッジを光らせる
      const rimLight = new THREE.PointLight(0xb7e4c7, 90, 25);
      rimLight.position.set(2, 4, -8);
      scene.add(rimLight);

      // アクセント: 下から淡い緑で浮遊感
      const bottomLight = new THREE.PointLight(0x52b788, 30, 20);
      bottomLight.position.set(0, -8, 3);
      scene.add(bottomLight);

      // ── マテリアル ────────────────────────────────────────────────
      const boneMat = new THREE.MeshStandardMaterial({
        color: new THREE.Color('#f0ede8'),
        roughness: 0.45,
        metalness: 0.05,
        emissive: new THREE.Color('#0a1a10'),
        emissiveIntensity: 0.12,
      });
      const discMat = new THREE.MeshStandardMaterial({
        color: new THREE.Color('#c8e0d0'),
        roughness: 0.55,
        metalness: 0.02,
        emissive: new THREE.Color('#0a2518'),
        emissiveIntensity: 0.18,
      });

      // ── 背骨グループ ──────────────────────────────────────────────
      const spine = new THREE.Group();
      scene.add(spine);

      // 椎骨定義: 強調した S カーブ
      const segments: { r: number; h: number; z: number }[] = [];
      for (let i = 0; i < 7; i++) {
        // 頸椎: 前方に大きくカーブ
        const t = i / 6;
        segments.push({ r: 0.18 + t * 0.04, h: 0.30, z: 0.7 - t * 1.0 });
      }
      for (let i = 0; i < 12; i++) {
        // 胸椎: 後方に大きくカーブ
        const t = i / 11;
        segments.push({ r: 0.22 + t * 0.06, h: 0.32, z: -0.3 - Math.sin(t * Math.PI) * 0.8 });
      }
      for (let i = 0; i < 5; i++) {
        // 腰椎: 前方に大きくカーブ
        const t = i / 4;
        segments.push({ r: 0.30 + t * 0.04, h: 0.36, z: -0.1 + t * 0.75 });
      }

      const totalH = segments.reduce((s, seg) => s + seg.h + 0.12, 0);
      let y = totalH / 2;

      segments.forEach((seg) => {
        y -= seg.h / 2;

        // 椎体
        const bodyGeo = new THREE.CylinderGeometry(seg.r, seg.r * 1.05, seg.h, 20);
        const body = new THREE.Mesh(bodyGeo, boneMat);
        body.position.set(0, y, seg.z);
        spine.add(body);

        // 横突起(左右)
        const procR = seg.r * 0.22;
        const procL = seg.r * 1.3 + procR;
        const procGeo = new THREE.CylinderGeometry(procR, procR * 0.75, procL, 8);
        const left = new THREE.Mesh(procGeo, boneMat);
        left.rotation.z = Math.PI / 2;
        left.position.set(procL / 2 + seg.r * 0.05, y, seg.z - seg.r * 0.3);
        spine.add(left);
        const right = new THREE.Mesh(procGeo, boneMat);
        right.rotation.z = Math.PI / 2;
        right.position.set(-(procL / 2 + seg.r * 0.05), y, seg.z - seg.r * 0.3);
        spine.add(right);

        // 棘突起(後方)
        const spineProcGeo = new THREE.CylinderGeometry(procR * 0.75, procR, seg.r * 1.8, 8);
        const spinousProc = new THREE.Mesh(spineProcGeo, boneMat);
        spinousProc.rotation.x = Math.PI / 2;
        spinousProc.position.set(0, y, seg.z - seg.r - seg.r * 0.9);
        spine.add(spinousProc);

        // 椎間板
        y -= seg.h / 2;
        const discH = 0.10;
        const discGeo = new THREE.CylinderGeometry(seg.r * 1.1, seg.r * 1.1, discH, 20);
        const disc = new THREE.Mesh(discGeo, discMat);
        disc.position.set(0, y - discH / 2, seg.z);
        spine.add(disc);
        y -= discH + 0.02;
      });

      // 仙骨
      const sacGeo = new THREE.CylinderGeometry(0.40, 0.28, 0.55, 20);
      const sacrum = new THREE.Mesh(sacGeo, boneMat);
      sacrum.position.set(0, y - 0.28, 0.35);
      spine.add(sacrum);

      // ── パーティクル(小さな緑の光点) ─────────────────────────────
      const particleCount = 18;
      const pPositions = new Float32Array(particleCount * 3);
      const pSeeds = new Float32Array(particleCount * 3); // offset・speed・radius
      for (let i = 0; i < particleCount; i++) {
        pSeeds[i * 3 + 0] = Math.random() * Math.PI * 2; // angle offset
        pSeeds[i * 3 + 1] = 0.4 + Math.random() * 0.6;  // speed factor
        pSeeds[i * 3 + 2] = 1.2 + Math.random() * 1.0;  // orbit radius
        const yp = (Math.random() - 0.5) * totalH * 0.9;
        pPositions[i * 3 + 0] = (Math.random() - 0.5) * 2.5;
        pPositions[i * 3 + 1] = yp;
        pPositions[i * 3 + 2] = (Math.random() - 0.5) * 2.0;
      }
      const pGeo = new THREE.BufferGeometry();
      pGeo.setAttribute('position', new THREE.BufferAttribute(pPositions, 3));
      const pMat = new THREE.PointsMaterial({ color: 0x52b788, size: 0.08, transparent: true, opacity: 0.45, sizeAttenuation: true });
      const particles = new THREE.Points(pGeo, pMat);
      scene.add(particles);

      // ── カメラ ────────────────────────────────────────────────────
      const resize = () => {
        const w = el.clientWidth, h = el.clientHeight;
        renderer.setSize(w, h, false);
        camera.aspect = w / Math.max(h, 1);
        const dist = w < 480 ? 20 : w < 768 ? 17 : 14;
        camera.position.set(0, 1.5, dist);
        camera.lookAt(0, 0, 0);
        camera.updateProjectionMatrix();
      };
      const ro = new ResizeObserver(resize);
      ro.observe(el);
      resize();

      // マウス/タッチで傾く
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

      // 静止画(reduced-motion)
      if (reduce) {
        spine.rotation.y = Math.PI * 0.15;
        renderer.render(scene, camera);
      } else {
        const posArr = pGeo.attributes.position.array as Float32Array;

        const tick = (now: number) => {
          raf = requestAnimationFrame(tick);
          if (!visible || document.hidden) return;
          const t = now / 1000;

          spine.rotation.y += 0.003 + (tx * 0.8 - spine.rotation.y * 0.1) * 0.04;
          spine.rotation.x += (ty * 0.3 - spine.rotation.x) * 0.03;
          spine.position.y = Math.sin(t * 0.3) * 0.12;

          // パーティクルをゆらゆら漂わせる
          for (let i = 0; i < particleCount; i++) {
            const ao = pSeeds[i * 3 + 0];
            const sp = pSeeds[i * 3 + 1];
            const rad = pSeeds[i * 3 + 2];
            posArr[i * 3 + 0] = Math.cos(t * sp * 0.3 + ao) * rad;
            posArr[i * 3 + 2] = Math.sin(t * sp * 0.25 + ao) * rad * 0.6;
            posArr[i * 3 + 1] += Math.sin(t * sp * 0.5 + ao) * 0.002;
            // Y がはみ出したらループ
            if (posArr[i * 3 + 1] > totalH * 0.55) posArr[i * 3 + 1] = -totalH * 0.55;
            if (posArr[i * 3 + 1] < -totalH * 0.55) posArr[i * 3 + 1] = totalH * 0.55;
          }
          pGeo.attributes.position.needsUpdate = true;

          renderer.render(scene, camera);
        };
        spine.rotation.y = Math.PI * 0.15;
        raf = requestAnimationFrame(tick);
      }

      cleanup = () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        io.disconnect();
        el.removeEventListener('pointermove', onMove);
        boneMat.dispose();
        discMat.dispose();
        pGeo.dispose();
        pMat.dispose();
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
