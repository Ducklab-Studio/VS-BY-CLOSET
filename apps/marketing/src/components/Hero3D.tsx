'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber';
import { ContactShadows, Environment, Lightformer } from '@react-three/drei';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import * as THREE from 'three';
import { gsap } from '@/lib/gsap';

/**
 * O monograma da marca extrudado de verdade — volume, chanfro e reflexo,
 * não uma textura fingindo profundidade.
 *
 * A versão anterior usava o PNG numa placa fina porque "não tínhamos vetor".
 * Tínhamos: os PDFs da identidade são vetoriais puros (nenhum /Subtype/Image,
 * só operadores de path). `public/brand/logo-mark.svg` é a marca extraída do
 * PDF do ícone — as 9 operações de preenchimento do PDF viraram 9 <path>, uma
 * a uma, justamente pra preservar quais contornos são furos de quais (a
 * montanha vive no negativo do V; achatar tudo num path só entregaria essa
 * relação à heurística de furos do SVGLoader em vez do arquivo original).
 */
const MARK_SRC = '/brand/logo-mark.svg';

/**
 * Contornos menores que isto (em unidades do SVG, onde a marca inteira tem
 * ~380) são as seis estrelinhas sobre a montanha. Elas medem de 3 a 11
 * unidades: o chanfro que dá a aresta bonita nas letras comeria a estrela
 * inteira, então cada grupo é extrudado com o relevo da sua própria escala.
 */
const STAR_MAX_SIZE = 24;

/** Fração da viewport que a marca pode ocupar em cada eixo. */
const FILL_X = 0.78;
const FILL_Y = 0.8;

/**
 * A geometria sai normalizada com altura 1 — o tamanho real é decidido em
 * cena, contra a viewport (ver `useFitScale`). Fixar a altura aqui foi o bug
 * do mobile: o `fov` do three é vertical, então a altura visível é constante
 * e quem encolhe na tela estreita é a largura.
 */
function useMarkGeometry() {
  const { paths } = useLoader(SVGLoader, MARK_SRC);

  return useMemo(() => {
    const letters: THREE.Shape[] = [];
    const stars: THREE.Shape[] = [];

    for (const path of paths) {
      for (const shape of SVGLoader.createShapes(path)) {
        const box = new THREE.Box2().setFromPoints(shape.getPoints(6));
        const size = box.getSize(new THREE.Vector2());
        (Math.max(size.x, size.y) < STAR_MAX_SIZE ? stars : letters).push(shape);
      }
    }

    const parts = [
      // Profundidade e chanfro são limitados pela montanha, não pelas hastes.
      // A montanha faz parte do mesmo contorno do V (elas se tocam), então
      // divide os mesmos parâmetros, e suas cristas têm poucas unidades de
      // espessura: com depth 34 e chanfro 2.2 — valores que ficam ótimos nas
      // hastes — o chanfro comia as cristas e as paredes laterais viravam um
      // amontoado no lugar do pico. Em 22/0.7 as hastes ainda têm volume e a
      // montanha continua legível.
      new THREE.ExtrudeGeometry(letters, {
        depth: 12,
        bevelEnabled: true,
        bevelThickness: 0.4,
        bevelSize: 0.25,
        bevelSegments: 3,
        curveSegments: 18,
      }),
    ];

    if (stars.length > 0) {
      // Estrelas sem chanfro: na escala em que aparecem o chanfro seria
      // sub-pixel, e o offset do contorno em ponta fina só arriscaria
      // geometria auto-intersectada. Relevo mais raso também as mantém
      // como acento, não como segunda camada de letra.
      parts.push(
        new THREE.ExtrudeGeometry(stars, {
          depth: 6,
          bevelEnabled: false,
          curveSegments: 12,
        }),
      );
    }

    // Junta antes de centralizar: centralizar cada lote pelo seu próprio bbox
    // desalinharia as estrelas da montanha.
    const geometry = mergeGeometries(parts);
    parts.forEach((p) => p.dispose());

    geometry.center();
    geometry.computeBoundingBox();
    const size = geometry.boundingBox!.getSize(new THREE.Vector3());
    geometry.scale(1 / size.y, 1 / size.y, 1 / size.y);

    return { geometry, aspect: size.x / size.y };
  }, [paths]);
}

/**
 * Escala que faz a marca caber na viewport nos dois eixos.
 *
 * `viewport` do R3F já vem em unidades de cena no plano z=0, e é reavaliado a
 * cada resize — então isto cobre retrato, paisagem e rotação de tela sem
 * nenhum breakpoint em JS. No desktop a altura é sempre a restrição; no
 * celular, a largura.
 */
function useFitScale(aspect: number) {
  const width = useThree((s) => s.viewport.width);
  const height = useThree((s) => s.viewport.height);

  return Math.min((width * FILL_X) / aspect, height * FILL_Y);
}

function Monogram({ still, parallax }: { still: boolean; parallax: boolean }) {
  const { geometry, aspect } = useMarkGeometry();
  const fit = useFitScale(aspect);
  const group = useRef<THREE.Group>(null);
  const entered = useRef(false);
  const [showShadow, setShowShadow] = useState(false);

  useEffect(() => () => geometry.dispose(), [geometry]);

  /**
   * Entrada: a marca nasce em escala 0 e cresce até o tamanho final, como
   * se chegasse na cena — em vez de aparecer pronta assim que o WebGL
   * termina de carregar. Só na primeira vez que `fit` fica disponível:
   * ele muda de novo a cada resize de janela, e resize não pode
   * redisparar a animação de entrada.
   *
   * Vive num useEffect (não no useFrame de baixo) porque só roda uma vez,
   * não a cada quadro — e porque anima uma propriedade (`scale`) que o
   * useFrame de baixo nunca toca, então os dois convivem sem disputar o
   * mesmo valor.
   *
   * A sombra de contato só aparece depois de um instante: sem isso ela
   * surge cheia sob uma marca ainda em escala 0 — sombra de algo que
   * ainda não existe na tela.
   */
  useEffect(() => {
    const g = group.current;
    if (!g || fit === 0) return;

    if (entered.current) {
      // Resize depois da entrada: só acompanha o novo tamanho, sem animar de novo.
      g.scale.setScalar(fit);
      return;
    }
    entered.current = true;

    if (still) {
      // Quem pediu menos movimento recebe a marca já no tamanho final.
      g.scale.setScalar(fit);
      setShowShadow(true);
      return;
    }

    const entrance = gsap.fromTo(
      g.scale,
      { x: 0, y: 0, z: 0 },
      { x: fit, y: fit, z: fit, duration: 1.3, ease: 'back.out(1.6)', delay: 0.15 },
    );
    const shadowTimer = setTimeout(() => setShowShadow(true), 400);
    return () => {
      entrance.kill();
      clearTimeout(shadowTimer);
      entered.current = false;
    };
  }, [fit, still]);

  useFrame(({ clock, pointer }, delta) => {
    const g = group.current;
    if (!g) return;

    // Repouso: um giro de ida e volta, não uma rotação completa. Amplitude
    // curta de propósito — passando de ~25° a montanha entra em ângulo
    // rasante e suas paredes laterais escondem o pico.
    const t = clock.elapsedTime;
    const idleY = still ? 0.3 : Math.sin(t * 0.32) * 0.34;
    const idleX = still ? -0.1 : Math.sin(t * 0.24) * 0.08;
    const bob = still ? 0 : Math.sin(t * 0.7) * 0.017;

    // O ponteiro inclina a peça — prova, pra quem move o mouse, que existe
    // geometria ali e não uma imagem girando. Só onde há cursor de verdade:
    // no toque o `pointer` só se mexe durante o arrasto, então isso viraria
    // a marca girando enquanto a pessoa tenta rolar a página.
    const px = parallax && !still ? pointer.x : 0;
    const py = parallax && !still ? pointer.y : 0;
    const targetY = idleY + px * 0.26;
    const targetX = idleX - py * 0.18;

    // Lerp independente de framerate — a 144Hz o mesmo fator fixo perseguiria
    // o alvo quase o dobro mais rápido que a 60Hz.
    const k = still ? 1 : 1 - Math.pow(0.001, delta);
    g.rotation.y += (targetY - g.rotation.y) * k;
    g.rotation.x += (targetX - g.rotation.x) * k;
    // O balanço é proporcional à escala, senão vira um pulo no celular e um
    // tremor imperceptível no desktop.
    g.position.y += (bob * fit - g.position.y) * k;
  });

  return (
    <>
      {/* scale inicial 0: o useEffect acima assume a partir daqui, seja
          animando (gsap) ou aplicando o valor final direto (still/reduced
          motion). Sem isso a marca apareceria no tamanho cheio por um
          instante antes do efeito rodar. */}
      <group ref={group} scale={0}>
        {/* O SVG tem Y pra baixo; girar π em X põe a marca de pé sem espelhar
            (X é preservado) e sem escala negativa, que inverteria as normais.
            A extrusão é simétrica em Z, então a face que passa a ficar de
            frente é idêntica à original. */}
        <mesh geometry={geometry} rotation={[Math.PI, 0, 0]} castShadow receiveShadow>
          {/* metalness 0: marsala é laca sobre dielétrico, não metal tingido —
              com metalness a difusa perde energia e o reflexo puxa a cor da
              peça, o que desloca o tom da marca. O clearcoat é contido porque
              ele soma brilho branco por cima do vermelho, e é parte de como a
              versão anterior virava rosa. */}
          <meshPhysicalMaterial
            color="#53131E"
            roughness={0.48}
            metalness={0}
            clearcoat={0.35}
            clearcoatRoughness={0.3}
            reflectivity={0.3}
          />
        </mesh>
      </group>

      {/* Presa à escala da marca, não a números absolutos: com a peça menor no
          celular, uma sombra de tamanho fixo apareceria como um borrão solto
          longe da base.
          `showShadow` atrasa a montagem até a marca já estar visível — sem
          isso a sombra aparece cheia sob uma marca ainda em escala 0. */}
      {showShadow && (
        <ContactShadows
          position={[0, -fit * 0.58, 0]}
          scale={fit * 3}
          blur={fit * 0.9}
          far={fit * 1.4}
          resolution={256}
          opacity={0.32}
          color="#53131E"
        />
      )}
    </>
  );
}

/**
 * Preferências de movimento e tipo de ponteiro.
 *
 * `reduce`: mesma regra do resto do site (ver ScrollReveal/HeroIntro) — quem
 * pediu menos animação recebe a peça parada, mas parada num ângulo de três
 * quartos, porque o volume é a informação, não o movimento.
 *
 * `fine`: distingue cursor de dedo. Ambos começam no valor seguro pro SSR e
 * só mudam depois da montagem, então o HTML do servidor e a primeira
 * renderização do cliente batem.
 */
function useMotionPrefs() {
  const [prefs, setPrefs] = useState({ reduced: false, fine: false });

  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const pointer = window.matchMedia('(pointer: fine)');
    const sync = () => setPrefs({ reduced: motion.matches, fine: pointer.matches });

    sync();
    motion.addEventListener('change', sync);
    pointer.addEventListener('change', sync);
    return () => {
      motion.removeEventListener('change', sync);
      pointer.removeEventListener('change', sync);
    };
  }, []);

  return prefs;
}

export function Hero3D() {
  const { reduced, fine } = useMotionPrefs();
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: '100px' });
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);

  return (
    // Altura menor no celular: 480px fixos comiam quase toda a tela de um
    // telefone e empurravam o resto da home pra fora da primeira dobra.
    <div
      ref={container}
      className="h-[360px] w-full sm:h-[440px] lg:h-[480px]"
      role="img"
      aria-label="Monograma VS by Closet em três dimensões"
    >
      <Canvas
        frameloop={visible ? (reduced ? 'demand' : 'always') : 'never'}
        shadows
        // Teto em 1.75: telas de celular passam de 3x, e renderizar a 3x só
        // gasta bateria — a peça é uma silhueta chapada de cor, não textura
        // fina onde a densidade extra apareceria.
        dpr={[1, 1.75]}
        gl={{ antialias: true }}
        camera={{ position: [0, 0, 5.2], fov: 40 }}
      >
        {/* Canvas transparente por padrão: a cena herda o creme da página. */}
        <Suspense fallback={null}>
          <Monogram still={reduced} parallax={fine} />

          {/* O orçamento de luz aqui é a cor da marca, não o gosto.
              #53131E é escuro (albedo linear ~0.087, 0.007, 0.013): a difusa
              é albedo × irradiância, então qualquer irradiância muito acima
              de 1.0 clareia o marsala em vez de iluminá-lo. A primeira versão
              somava 0.55 + 2.4 + 1.1 ≈ 2.9 e devolvia #8A2637 já na difusa —
              somado ao IBL e ao clearcoat, era o rosa que aparecia na tela.
              Esta soma fica perto de 1.0 de propósito. */}
          <ambientLight intensity={0.12} />
          <directionalLight
            position={[3.5, 5, 5]}
            intensity={0.9}
            castShadow
            // 512 basta pra um objeto só, e poupa um passe de profundidade
            // caro no celular. A sombra aqui é auto-sombra (o S sobre o V);
            // não há plano recebendo, então resolução alta não compraria nada.
            shadow-mapSize={[512, 512]}
            shadow-bias={-0.0004}
          />
          {/* Contraluz cor de areia: separa o marsala do fundo creme, que de
              outro modo achataria a silhueta contra a página. */}
          <directionalLight position={[-4, 1.5, -3]} intensity={0.35} color="#F2D9A0" />

          {/* Ambiente montado com Lightformers em vez de um preset HDR: o
              preset baixaria o mapa de um CDN, e a marca não pode depender de
              rede externa pra aparecer inteira.
              environmentIntensity segura a contribuição difusa do mapa, que
              entra no mesmo orçamento das luzes acima. */}
          <Environment resolution={256} environmentIntensity={0.4}>
            <Lightformer
              form="rect"
              intensity={1.2}
              position={[0, 2.5, 4]}
              scale={[7, 5, 1]}
              color="#FFFCF6"
            />
            <Lightformer
              form="rect"
              intensity={0.7}
              position={[-4, 0.5, 2]}
              rotation={[0, Math.PI / 3, 0]}
              scale={[4, 4, 1]}
              color="#F2E5C6"
            />
            <Lightformer
              form="circle"
              intensity={0.8}
              position={[3, -1.5, 2.5]}
              scale={[3, 3, 1]}
              color="#F2D9A0"
            />
          </Environment>
        </Suspense>
      </Canvas>
    </div>
  );
}
