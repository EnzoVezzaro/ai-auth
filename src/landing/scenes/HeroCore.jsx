import { useEffect, useRef } from "react";
import * as THREE from "three";

const CYAN = 0x8fe6ff;
const WARM = 0xf0c98d;

export default function HeroCore() {
  const hostRef = useRef(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: true,
        powerPreference: "high-performance",
      });
    } catch {
      return undefined;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    camera.position.set(0, 0, 7.6);

    const root = new THREE.Group();
    scene.add(root);

    const shellGeometry = new THREE.IcosahedronGeometry(1.52, 1);
    const shellMaterial = new THREE.MeshStandardMaterial({
      color: 0x142630,
      metalness: 0.88,
      roughness: 0.24,
      transparent: true,
      opacity: 0.62,
      flatShading: true,
      side: THREE.DoubleSide,
    });
    const shell = new THREE.Mesh(shellGeometry, shellMaterial);
    root.add(shell);

    const edgeGeometry = new THREE.EdgesGeometry(shellGeometry, 18);
    const edgeMaterial = new THREE.LineBasicMaterial({
      color: CYAN,
      transparent: true,
      opacity: 0.32,
    });
    root.add(new THREE.LineSegments(edgeGeometry, edgeMaterial));

    const coreGeometry = new THREE.OctahedronGeometry(0.7, 0);
    const coreMaterial = new THREE.MeshStandardMaterial({
      color: CYAN,
      emissive: 0x1c6376,
      emissiveIntensity: 1,
      metalness: 0.45,
      roughness: 0.14,
      flatShading: true,
    });
    const core = new THREE.Mesh(coreGeometry, coreMaterial);
    root.add(core);

    const innerGeometry = new THREE.IcosahedronGeometry(0.42, 0);
    const innerMaterial = new THREE.MeshBasicMaterial({
      color: 0xe9fbff,
      wireframe: true,
      transparent: true,
      opacity: 0.55,
    });
    const innerWire = new THREE.Mesh(innerGeometry, innerMaterial);
    root.add(innerWire);

    const ringMeshes = [];
    const ringConfigs = [
      [2.02, 0x8fe6ff, 0.38, [0.4, 0.2, 0]],
      [2.25, 0xc8d8e2, 0.22, [1.2, 0.6, 1.1]],
      [2.48, WARM, 0.2, [0.2, 1.3, -0.6]],
    ];
    for (const [radius, color, opacity, rotation] of ringConfigs) {
      const geometry = new THREE.TorusGeometry(radius, 0.008, 6, 180);
      const material = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
      });
      const ring = new THREE.Mesh(geometry, material);
      ring.rotation.set(...rotation);
      root.add(ring);
      ringMeshes.push(ring);
    }

    const tickVertices = [];
    for (let i = 0; i < 32; i += 1) {
      const angle = (i / 32) * Math.PI * 2;
      const long = i % 4 === 0 ? 0.14 : 0.07;
      const radius = 1.78;
      tickVertices.push(
        Math.cos(angle) * radius,
        -long / 2,
        Math.sin(angle) * radius,
        Math.cos(angle) * radius,
        long / 2,
        Math.sin(angle) * radius,
      );
    }
    const tickGeometry = new THREE.BufferGeometry();
    tickGeometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(tickVertices, 3),
    );
    const tickMaterial = new THREE.LineBasicMaterial({
      color: WARM,
      transparent: true,
      opacity: 0.6,
    });
    root.add(new THREE.LineSegments(tickGeometry, tickMaterial));

    const particleCount = 380;
    const positions = new Float32Array(particleCount * 3);
    for (let i = 0; i < particleCount; i += 1) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const radius = 2.4 + Math.random() * 1.25;
      positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = radius * Math.cos(phi);
      positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
    }
    const particleGeometry = new THREE.BufferGeometry();
    particleGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(positions, 3),
    );
    const particleMaterial = new THREE.PointsMaterial({
      color: 0xbfefff,
      size: 0.022,
      transparent: true,
      opacity: 0.62,
      sizeAttenuation: true,
      depthWrite: false,
    });
    const particles = new THREE.Points(particleGeometry, particleMaterial);
    root.add(particles);

    const nodeGeometry = new THREE.OctahedronGeometry(0.12, 0);
    const nodeMaterial = new THREE.MeshBasicMaterial({ color: WARM });
    const node = new THREE.Mesh(nodeGeometry, nodeMaterial);
    node.position.set(2.55, -1.15, 0.15);
    root.add(node);

    const linkGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(1.15, -0.5, 0),
      new THREE.Vector3(2.55, -1.15, 0.15),
    ]);
    const linkMaterial = new THREE.LineDashedMaterial({
      color: WARM,
      dashSize: 0.08,
      gapSize: 0.06,
      transparent: true,
      opacity: 0.55,
    });
    const link = new THREE.Line(linkGeometry, linkMaterial);
    link.computeLineDistances();
    root.add(link);

    const packetGeometry = new THREE.SphereGeometry(0.055, 10, 10);
    const packetMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const packet = new THREE.Mesh(packetGeometry, packetMaterial);
    root.add(packet);

    scene.add(new THREE.AmbientLight(0x9fd8ff, 0.75));
    const keyLight = new THREE.PointLight(CYAN, 38, 22);
    keyLight.position.set(3.5, 2.5, 5);
    scene.add(keyLight);
    const fillLight = new THREE.PointLight(WARM, 24, 20);
    fillLight.position.set(-4, -1.5, 3);
    scene.add(fillLight);

    const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    const onPointer = (event) => {
      pointer.tx = (event.clientX / window.innerWidth) * 2 - 1;
      pointer.ty = (event.clientY / window.innerHeight) * 2 - 1;
    };
    window.addEventListener("pointermove", onPointer, { passive: true });

    let scrollTarget = 0;
    const onScroll = () => {
      scrollTarget = Math.min(
        window.scrollY / Math.max(window.innerHeight, 1),
        1.4,
      );
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    let width = 0;
    let height = 0;
    const resize = () => {
      const rect = host.getBoundingClientRect();
      width = Math.max(rect.width, 1);
      height = Math.max(rect.height, 1);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    resize();

    const clock = new THREE.Clock();
    let frame = 0;
    let visible = true;
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    let lastRender = 0;
    const draw = () => {
      const time = clock.getElapsedTime();
      if (!reduced && time - lastRender < 1 / 30) {
        frame = requestAnimationFrame(draw);
        return;
      }
      lastRender = time;
      pointer.x += (pointer.tx - pointer.x) * 0.045;
      pointer.y += (pointer.ty - pointer.y) * 0.045;
      root.rotation.y = time * 0.12 + pointer.x * 0.28 + scrollTarget * 0.7;
      root.rotation.x = pointer.y * 0.17 + scrollTarget * 0.22;
      root.position.x = pointer.x * 0.16;
      root.position.y = -pointer.y * 0.12;
      shell.rotation.y = -time * 0.07;
      core.rotation.y = time * 0.55;
      core.rotation.z = time * 0.18;
      innerWire.rotation.x = time * 0.35;
      innerWire.rotation.y = -time * 0.4;
      ringMeshes[0].rotation.z = time * 0.16;
      ringMeshes[1].rotation.y = time * -0.11;
      ringMeshes[2].rotation.x = time * 0.09;
      particles.rotation.y = time * 0.035;
      const pulse = 1 + Math.sin(time * 1.5) * 0.035;
      core.scale.setScalar(pulse);
      const travel = (time % 2.6) / 2.6;
      packet.position.set(
        1.15 + 1.4 * travel,
        -0.5 - 0.65 * travel,
        0 + 0.15 * travel,
      );
      packetMaterial.opacity = 1;
      camera.position.z = 7.6 - scrollTarget * 0.8;
      renderer.render(scene, camera);
      if (!reduced && visible) frame = requestAnimationFrame(draw);
    };

    const visibilityObserver = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        if (visible && !frame && !reduced) {
          clock.getDelta();
          frame = requestAnimationFrame(draw);
        }
        if (!visible && frame) {
          cancelAnimationFrame(frame);
          frame = 0;
        }
      },
      { rootMargin: "120px" },
    );
    visibilityObserver.observe(host);
    if (reduced) draw();
    else frame = requestAnimationFrame(draw);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      visibilityObserver.disconnect();
      resizeObserver.disconnect();
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("scroll", onScroll);
      [
        shellGeometry,
        edgeGeometry,
        coreGeometry,
        innerGeometry,
        particleGeometry,
        tickGeometry,
        nodeGeometry,
        linkGeometry,
        packetGeometry,
        ...ringMeshes.map((ring) => ring.geometry),
      ].forEach((geometry) => geometry.dispose());
      [
        shellMaterial,
        edgeMaterial,
        coreMaterial,
        innerMaterial,
        particleMaterial,
        tickMaterial,
        nodeMaterial,
        linkMaterial,
        packetMaterial,
        ...ringMeshes.map((ring) => ring.material),
      ].forEach((material) => material.dispose());
      renderer.dispose();
      if (renderer.domElement.parentNode === host) {
        host.removeChild(renderer.domElement);
      }
    };
  }, []);

  return <div className="threeui-background" ref={hostRef} />;
}
