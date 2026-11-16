import { useEffect, useRef } from "react";
import * as THREE from "three";

const CYAN = 0x8fe6ff;
const WARM = 0xf0c98d;
const PALE = 0xd8e4ea;

const NODES = [
  { kind: "identity", position: [0, 0, 0] },
  { kind: "site", position: [-3.4, 1.5, -0.6] },
  { kind: "site", position: [3.5, 1.2, -1] },
  { kind: "site", position: [0.4, 2.9, -1.8] },
  { kind: "agent", position: [-2.5, -1.9, 0.6] },
  { kind: "agent", position: [2.6, -1.8, 0.3] },
  { kind: "agent", position: [-4.4, -0.2, -1.2] },
  { kind: "agent", position: [4.3, -0.4, -1.1] },
  { kind: "agent", position: [0.1, -3.3, -0.9] },
];

const EDGES = [
  [0, 1],
  [0, 2],
  [0, 3],
  [0, 4],
  [0, 5],
  [0, 6],
  [0, 7],
  [0, 8],
  [1, 4],
  [2, 5],
  [3, 8],
  [4, 8],
  [5, 8],
];

export default function Network() {
  const hostRef = useRef(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    } catch {
      return undefined;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 100);
    camera.position.set(0, 0, 11.5);

    const group = new THREE.Group();
    scene.add(group);

    const geometries = [];
    const materials = [];
    const meshes = [];

    NODES.forEach((node, index) => {
      const isIdentity = node.kind === "identity";
      const isSite = node.kind === "site";
      const geometry = isIdentity
        ? new THREE.IcosahedronGeometry(0.62, 1)
        : isSite
          ? new THREE.BoxGeometry(0.64, 0.64, 0.64)
          : new THREE.OctahedronGeometry(0.27, 0);
      const material = isIdentity
        ? new THREE.MeshStandardMaterial({
            color: CYAN,
            emissive: 0x1d6474,
            emissiveIntensity: 0.9,
            metalness: 0.5,
            roughness: 0.2,
            flatShading: true,
          })
        : isSite
          ? new THREE.MeshStandardMaterial({
              color: 0x2a2926,
              emissive: 0x6b5230,
              emissiveIntensity: 0.35,
              metalness: 0.7,
              roughness: 0.35,
            })
          : new THREE.MeshStandardMaterial({
              color: PALE,
              emissive: 0x22343c,
              emissiveIntensity: 0.4,
              metalness: 0.6,
              roughness: 0.3,
              flatShading: true,
            });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(...node.position);
      mesh.userData = { kind: node.kind, index, base: mesh.position.clone() };
      group.add(mesh);
      geometries.push(geometry);
      materials.push(material);
      meshes.push(mesh);

      const haloGeometry = new THREE.RingGeometry(0.82, 0.84, 48);
      const haloMaterial = new THREE.MeshBasicMaterial({
        color: isIdentity ? CYAN : isSite ? WARM : PALE,
        transparent: true,
        opacity: isIdentity ? 0.4 : 0.16,
        side: THREE.DoubleSide,
      });
      const halo = new THREE.Mesh(haloGeometry, haloMaterial);
      halo.position.copy(mesh.position);
      halo.userData.faceCamera = true;
      group.add(halo);
      geometries.push(haloGeometry);
      materials.push(haloMaterial);
      meshes.push(halo);
    });

    const lineGeometry = new THREE.BufferGeometry();
    const linePositions = [];
    EDGES.forEach(([a, b]) => {
      linePositions.push(...NODES[a].position, ...NODES[b].position);
    });
    lineGeometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(linePositions, 3),
    );
    const lineMaterial = new THREE.LineBasicMaterial({
      color: 0x7fb5c8,
      transparent: true,
      opacity: 0.22,
    });
    group.add(new THREE.LineSegments(lineGeometry, lineMaterial));
    geometries.push(lineGeometry);
    materials.push(lineMaterial);

    const packetGeometry = new THREE.SphereGeometry(0.065, 10, 10);
    const packets = EDGES.map(([a, b], index) => {
      const material = new THREE.MeshBasicMaterial({
        color: index % 3 === 0 ? WARM : CYAN,
        transparent: true,
        opacity: 0.85,
      });
      const mesh = new THREE.Mesh(packetGeometry, material);
      group.add(mesh);
      materials.push(material);
      return {
        mesh,
        from: new THREE.Vector3(...NODES[a].position),
        to: new THREE.Vector3(...NODES[b].position),
        offset: (index * 0.17) % 1,
      };
    });
    geometries.push(packetGeometry);

    scene.add(new THREE.AmbientLight(0xbfe6ff, 0.8));
    const light = new THREE.PointLight(CYAN, 45, 24);
    light.position.set(4, 4, 6);
    scene.add(light);
    const warmLight = new THREE.PointLight(WARM, 26, 22);
    warmLight.position.set(-5, -2, 4);
    scene.add(warmLight);

    const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    const onPointer = (event) => {
      pointer.tx = (event.clientX / window.innerWidth) * 2 - 1;
      pointer.ty = (event.clientY / window.innerHeight) * 2 - 1;
    };
    window.addEventListener("pointermove", onPointer, { passive: true });

    let scroll = 0;
    const onScroll = () => {
      scroll = Math.min(window.scrollY / Math.max(window.innerHeight, 1), 2);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    let width = 1;
    let height = 1;
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
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    let frame = 0;
    let visible = true;

    let lastRender = 0;
    const draw = () => {
      const time = clock.getElapsedTime();
      if (!reduced && time - lastRender < 1 / 30) {
        frame = requestAnimationFrame(draw);
        return;
      }
      lastRender = time;
      pointer.x += (pointer.tx - pointer.x) * 0.04;
      pointer.y += (pointer.ty - pointer.y) * 0.04;
      group.rotation.y = pointer.x * 0.22 + scroll * 0.16 + time * 0.025;
      group.rotation.x = pointer.y * 0.12;
      meshes.forEach((mesh) => {
        if (mesh.userData.faceCamera) mesh.quaternion.copy(camera.quaternion);
        else if (mesh.userData.kind === "agent") {
          mesh.rotation.y = time * 0.4 + mesh.userData.index;
          mesh.rotation.x = time * 0.2;
        } else if (mesh.userData.kind === "identity") {
          mesh.rotation.y = time * 0.18;
          mesh.rotation.x = time * 0.1;
        }
      });
      packets.forEach(({ mesh, from, to, offset }) => {
        const t = (time * 0.22 + offset) % 1;
        mesh.position.lerpVectors(from, to, t);
        mesh.material.opacity = Math.sin(t * Math.PI) * 0.85;
      });
      renderer.render(scene, camera);
      if (!reduced && visible) frame = requestAnimationFrame(draw);
    };

    const visibilityObserver = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        if (visible && !frame && !reduced) frame = requestAnimationFrame(draw);
        if (!visible && frame) {
          cancelAnimationFrame(frame);
          frame = 0;
        }
      },
      { rootMargin: "160px" },
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
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((material) => material.dispose());
      renderer.dispose();
      if (renderer.domElement.parentNode === host) {
        host.removeChild(renderer.domElement);
      }
    };
  }, []);

  return <div className="threeui-background" ref={hostRef} />;
}
