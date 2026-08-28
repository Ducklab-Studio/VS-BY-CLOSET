'use client';

import { Suspense, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { useTexture } from '@react-three/drei';
import * as THREE from 'three';

/**
 * O monograma real (V+S com a montanha no negativo) como card 3D flutuante.
 *
 * A arte veio como PNG/PDF, sem malha 3D nem SVG vetorial — extrudar a marca
 * de verdade (dar volume às letras) exigiria um caminho vetorial que não
 * temos. Em vez de fingir profundidade que não existe, uso a arte real como
 * textura numa placa fina que gira devagar no espaço: honesto sobre o que é,
 * e ainda assim prova o pipeline R3F/Three funcionando ponta a ponta.
 */
function LogoCard() {
  const texture = useTexture('/brand/logo-mark-marsala.png');
  // Three.js (r152+) não assume mais sRGB nas texturas carregadas — sem isso
  // o marsala sai escurecido/dessaturado em vez da cor real da marca.
  texture.colorSpace = THREE.SRGBColorSpace;
  const meshRef = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    if (!meshRef.current) return;
    meshRef.current.rotation.y = clock.elapsedTime * 0.5;
    meshRef.current.position.y = Math.sin(clock.elapsedTime * 0.8) * 0.08;
  });

  return (
    <mesh ref={meshRef}>
      {/* Marca real é 705×800 (levemente vertical, por causa da haste do S)
          — plano na mesma proporção pra não esticar a arte. */}
      <planeGeometry args={[2.2, 2.2 / (705 / 800)]} />
      <meshBasicMaterial
        map={texture}
        transparent
        alphaTest={0.1}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

export function Hero3D() {
  return (
    <div className="h-[480px] w-full">
      <Canvas camera={{ position: [0, 0, 4], fov: 45 }}>
        {/* Fundo do Canvas fica transparente por padrão, então a cena já
            herda o creme da página atrás dela — sem precisar de <color>. */}
        <Suspense fallback={null}>
          <LogoCard />
        </Suspense>
      </Canvas>
    </div>
  );
}
