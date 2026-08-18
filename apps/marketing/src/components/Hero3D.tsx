'use client';

import { Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { Environment, OrbitControls } from '@react-three/drei';

/**
 * Prova de que o pipeline R3F/Three/Drei está funcionando de ponta a ponta.
 *
 * A forma e o material aqui são deliberadamente genéricos — o objeto 3D real
 * (peça de roupa, cena de neve, o que a identidade visual pedir) substitui
 * este placeholder quando a marca chegar. O que importa hoje é confirmar que
 * Canvas monta, renderiza e não quebra o SSR do Next.
 */
export function Hero3D() {
  return (
    <div className="h-[480px] w-full">
      <Canvas camera={{ position: [0, 0, 4], fov: 45 }}>
        <Suspense fallback={null}>
          <ambientLight intensity={0.6} />
          <directionalLight position={[3, 3, 3]} intensity={1.2} />
          <mesh rotation={[0.4, 0.4, 0]}>
            <torusKnotGeometry args={[1, 0.3, 128, 16]} />
            <meshStandardMaterial color="#ffffff" roughness={0.3} metalness={0.2} />
          </mesh>
          <Environment preset="city" />
        </Suspense>
        <OrbitControls enableZoom={false} autoRotate autoRotateSpeed={0.6} />
      </Canvas>
    </div>
  );
}
