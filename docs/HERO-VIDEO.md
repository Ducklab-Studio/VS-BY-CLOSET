# Vídeo do hero da home — implementação, limites reais e como adicionar o vídeo do Orlando

**Estado atual:** vídeo oficial do cliente integrado em `apps/marketing/public/editorial/video/hero-v1.mp4` e configurado em `apps/marketing/src/lib/hero-media.ts`. A imagem do hero continua ativa como fallback imediato (LCP) e para conexões lentas / `prefers-reduced-motion`. Rollback: `HERO_VIDEO = null`.

## 1. Como adicionar o vídeo do Orlando (passo a passo exato)
1. **Receber** o arquivo mestre (o melhor que existir, ex. ProRes/H.264 de alta qualidade) **e a autorização de uso** (imagem das pessoas e, se houver, trilha — o vídeo vai sempre mudo).
2. **Exportar** (ffmpeg; ajuste o trecho `-ss/-t` para um loop natural de 4–12 s, com o último quadro combinando com o primeiro):
   - **Desktop, MP4 (obrigatório):**
     `ffmpeg -i mestre.mov -an -t 8 -vf "scale=1080:-2,fps=24" -c:v libx264 -profile:v high -preset slow -crf 25 -pix_fmt yuv420p -g 48 -movflags +faststart hero-v1.mp4`
   - **Celular, MP4 (vertical):** `... -vf "crop=ih*9/16:ih,scale=480:-2,fps=24" ... hero-v1-m.mp4` (ou, melhor, uma exportação vertical própria feita pelo Orlando; 480×854).
   - **WebM (opcional):** `-c:v libvpx-vp9 -b:v 0 -crf 34 -row-mt 1 -g 48 -pix_fmt yuv420p` — **só inclua se ficar pelo menos ~15% menor** que o MP4 com a mesma qualidade (o WebM é pedido antes do MP4; num teste sintético ele saiu 2,9× MAIOR que o MP4, e aí atrapalha em vez de ajudar).
   - Sempre `-an` (sem áudio), 24–30 fps, `yuv420p`, `+faststart`.
3. **Copiar** para `apps/marketing/public/editorial/video/` com nome **versionado** (`hero-v1.mp4`, `hero-v1-m.mp4`, …). Esses arquivos têm cache imutável de 1 ano (`next.config.mjs`): para trocar o vídeo depois, use um nome novo (`hero-v2…`).
4. **Conferir os arquivos:** `pnpm --filter @valle/marketing check:hero-video public/editorial/video/hero-v1.mp4 public/editorial/video/hero-v1-m.mp4` (e os `.webm`). Corrija todo ✗; avalie os ⚠ (ver "orçamento de pixels" na seção 5).
5. **Ligar:** em `src/lib/hero-media.ts` troque `null` por (ajuste os nomes e as posições):
   ```ts
   export const HERO_VIDEO: HeroVideo | null = {
     mp4: '/editorial/video/hero-v1.mp4',
     webm: '/editorial/video/hero-v1.webm', // só se for bem menor que o MP4
     mobile: { mp4: '/editorial/video/hero-v1-m.mp4' },
     position: { desktop: '67% center', mobile: '50% 30%' }, // protege o rosto/elemento principal
   };
   ```
   A imagem do hero usa a MESMA posição (a troca imagem→vídeo não "pula").
6. **Testar:** `pnpm --filter @valle/marketing exec node --test test/hero-media.test.mjs` e `pnpm --filter @valle/marketing test:hero-video` (cenários de navegador com clipes sintéticos; não usa o arquivo real), conferir no navegador em desktop e celular e **fazer o teste físico em iPhone/iPad (seção 6)**.
7. **Publicar:** PR em Draft → CI → validação → merge/deploy (cada um com autorização). **Rollback:** `HERO_VIDEO = null`.

## 2. O que o código faz
Máquina de estados pura em `src/lib/hero-media.ts` (testada) + `src/components/HeroMedia.tsx`.

| Fase | O que a pessoa vê |
|---|---|
| `off` | Só a imagem (sem vídeo configurado). Nenhum `<video>` na página. |
| `manual` | Só a imagem + botão "Reproduzir". Nada é baixado até o clique (reduzir movimento, economia de dados ou conexão 2g/3g). |
| `waiting-image` → `loading` | A imagem do hero (LCP) carrega **primeiro**; só depois o vídeo é pedido (sem atraso fixo). Imagem visível. |
| `playing` | O vídeo faz fade-in por cima da imagem **somente quando um frame foi realmente apresentado** (`requestVideoFrameCallback`; sem isso, evento `playing`). Nunca há tela preta. |
| `stalled` | Travou (buffer) por mais de 2,5 s: volta à imagem; se recuperar, o vídeo reaparece. |
| `blocked` | O navegador recusou o `play()` (`NotAllowedError`: política de autoplay ou Modo Pouca Energia): imagem + botão "Reproduzir". Sem hacks. |
| `failed` | Arquivo ausente, erro de decodificação ou **timeout de 8 s sem primeiro frame**: o `<video>` é removido (o download é solto) e fica a imagem, sem botão. |

- **Pausa** quando o hero sai da tela (IntersectionObserver) ou a aba fica oculta; retoma sozinho. **Pausa do usuário** (botão) vale até a pessoa tocar de novo.
- **Botão** discreto (vidro escuro, 44 px, foco visível, `aria-label`): "Pausar vídeo de fundo" enquanto toca; "Reproduzir vídeo de fundo" quando parado por escolha, política ou preferência. No desktop fica no canto superior direito; no celular, no inferior esquerdo. Nunca cobre título nem botão do hero (testado em 10 larguras).
- **Preferências ao vivo:** mudar "reduzir movimento" ou a economia de dados durante a visita pausa o vídeo e volta à imagem; relaxar volta ao automático (se a pessoa não escolheu o manual).
- **Sem áudio, sem foco** (`muted`, `playsinline`, `aria-hidden`, `tabIndex=-1`), sem Picture-in-Picture.
- **Fontes:** WebM/VP9 antes do MP4/H.264 (o navegador baixa só UMA). Celular x desktop é escolhido em JavaScript (`media` em `<source>` de vídeo é ignorado pelos navegadores). A falha de uma fonte intermediária **não** derruba o vídeo: o navegador tenta a próxima (WebM → MP4); só a última é terminal.
- **Sem layout shift:** o vídeo é absoluto sobre a imagem; a altura do hero não muda (testado).
- **CSP:** `media-src 'self'`: o vídeo precisa ser do próprio domínio (é: `public/`). **Cache:** `/editorial/video/*` com `Cache-Control: public, max-age=31536000, immutable`; a Vercel atende requisições por faixa (Range).

## 3. Compatibilidade (estratégia)
| Ambiente | Comportamento |
|---|---|
| Chrome/Edge/Firefox desktop, Chrome/Samsung Internet/Firefox Android | Autoplay automático (mudo, inline); WebM ou MP4. |
| Safari macOS | Autoplay mudo permitido; MP4/H.264 garantido (WebM conforme a versão). |
| Safari iOS/iPadOS e navegadores iOS (WebKit) | Autoplay mudo e `playsinline` (sem tela cheia). Ver limitações na seção 4. |
| Navegador antigo sem `requestVideoFrameCallback`/IntersectionObserver | Usa o evento `playing`; sem IntersectionObserver o vídeo só não pausa fora da tela. |
| Sem suporte a WebM | Cai no MP4. |
| Qualquer falha | Imagem. |

## 4. Limitações reais do autoplay no iOS (não contornadas de propósito)
- O Safari permite autoplay **somente de vídeo mudo e `playsinline`**; sem `playsinline` o iPhone abre em tela cheia. Já atendemos os dois (atributos definidos antes do `play()`).
- **Modo Pouca Energia:** o comportamento conhecido do iOS é desligar o autoplay de vídeo; o `play()` é recusado (`NotAllowedError`) até haver um gesto do usuário (varia por versão; **a confirmar em aparelho**). É a política do sistema: **não** usamos áudio silencioso, cliques artificiais nem reprodução forçada. O hero fica na imagem, com o botão "Reproduzir", que chama `play()` dentro do clique real.
- "Reduzir Movimento" do iOS vira `prefers-reduced-motion`: modo manual (nada baixa antes do clique).
- O comportamento exato varia por versão do iOS/Safari. **Isto NÃO foi testado em aparelho real**: emular iPhone no Chromium não prova o Safari. Veja o checklist físico abaixo.

## 5. Performance — medido
Ferramenta: `apps/marketing/test/hero-video-perf.mjs` (manual; 3 builds; clipes **sintéticos** de 6 s para comparar variantes, não para prever o peso do vídeo do Orlando). Medianas de 3 execuções; Chromium com limitação de rede via CDP; celular com DPR 2. A = só imagem (estado entregue) · B = estrutura anterior (PR #135) · C = esta branch.

| Tela / rede | Variante | LCP | CLS | Começa a tocar | 1º frame visível | Bytes de imagem | Requisições de vídeo |
|---|---|---|---|---|---|---|---|
| Desktop, sem limite | A | 244 ms | 0 | — | — | 106 KB | 0 |
| | B | 216 ms | 0 | 1067 ms | 1070 ms | **242 KB** | 1 |
| | C | 216 ms | 0 | **717 ms** | **748 ms** | 106 KB | 1 |
| Desktop, 4G (1,6 Mbps/150 ms) | A | 1128 ms | 0 | — | — | 74 KB | 0 |
| | B | 1088 ms | 0 | 4456 ms | 4457 ms | 210 KB | 1 |
| | C | 1124 ms | 0 | **3593 ms** | **3633 ms** | 74 KB | 1 |
| Celular, 4G | A | 1012 ms | 0 | — | — | 65 KB | 0 |
| | B | 988 ms | 0 | 4283 ms | 4285 ms | 201 KB | 1 (clipe de desktop) |
| | C | 1012 ms | 0 | **3099 ms** | **3131 ms** | 65 KB | 1 (clipe de celular, ~1,2 MB) |
| Desktop e celular, 3G lento | A/B/C | 4056/4040/4080 ms (desktop) · 3204/3196/3208 ms (celular) | 0 | — | — | — | **0** (modo manual: nada baixa) |

O que isso mostra: **LCP e CLS iguais à base** em todas as condições; o vídeo começa 19–33% mais cedo que na versão anterior (sem atraso de 300 ms, clipe de celular menor, sem `poster` bruto), com menos bytes de imagem (a versão anterior baixava a imagem bruta como `poster`: +136 KB); em conexão lenta, economia de dados ou "reduzir movimento" **nada de mídia é baixado**.

**Orçamento de pixels (descoberta importante).** O Chrome conta o **primeiro frame do vídeo como candidato a LCP** quando a área do vídeo (largura×altura) é **maior** que a da imagem entregue. Num teste isolado (rede 4G): vídeo 1280×720 (921 600 px) contra a imagem de 1080×720 (777 600 px) → o LCP passou a ser o vídeo (3,9 s contra 1,1 s); vídeos de 1080×720 ou menores **não alteram o LCP**; usar `poster` não resolve. Por isso:
- **Desktop: até 1080×608** (≈ 657 000 px, ≤ 777 600). **Celular: até 480×854** (≈ 410 000 px, ≤ 457 000 px da imagem entregue a telas de DPR 2). O verificador (`check:hero-video`) avisa quando passa disso.
- Passar do orçamento é uma decisão de qualidade × LCP: aceitável só se o 1º frame chegar rápido (o LCP vira o tempo do 1º frame). Em DPR 1 o orçamento é menor (a imagem entregue é menor); em DPR 3 é maior.
- Dica de peso: GOP de ~2 s (`-g 48`), `faststart`, sem áudio, 24 fps; o primeiro keyframe grande atrasa o 1º frame.

## 6. Testes
- **Unidade** (`test/hero-media.test.mjs`, 15): decisão (reduzir movimento, economia de dados, 2g/3g), fontes WebM/MP4 e celular/desktop, posições, todas as transições da máquina de estados (autoplay permitido/recusado, Pouca Energia, manual, arquivo ausente, decodificação, timeout, stall, aba, viewport, mudança de preferência, vídeo desativado) e estrutura do componente (sem hacks de autoplay).
- **Navegador** (`pnpm --filter @valle/marketing test:hero-video`, 22 verificações em **Chromium** e **Microsoft Edge**/H.264): autoplay permitido (desktop e celular, 1 download do conjunto certo, vídeo só depois da imagem, hero sem mudar de altura), `play()` recusado sem gesto (simula Pouca Energia) + clique real, pausa/retomada, reduzir movimento, economia de dados e 3g (0 requisições até o clique), 404, erro de decodificação, timeout (desiste antes da resposta lenta e não ressuscita), stall e recuperação, aba oculta, fora da viewport, WebM indisponível → MP4, mesmo enquadramento de imagem e vídeo, e 10 tamanhos de tela (iPhone SE a ultrawide: sem rolagem lateral, botão ≥ 44 px que não cobre título/CTA). O console não pode ter erros de JavaScript. Os testes ligam `HERO_VIDEO` só durante a execução (clipes sintéticos; o arquivo é restaurado no final).
- **Não cobrem:** Safari/iOS reais, Samsung Internet, Firefox (não instalados neste ambiente de teste), Modo Pouca Energia real, aparelhos antigos.

### Checklist de teste físico (obrigatório antes do lançamento)
Para cada item, anotar: toca sozinho? botão correto? imagem sem tela preta? título legível? rolagem lateral?
- [ ] iPhone com Safari — Modo Pouca Energia **desligado**: autoplay mudo e inline.
- [ ] iPhone com Safari — Modo Pouca Energia **ligado**: deve ficar a imagem + botão "Reproduzir"; tocar no botão inicia o vídeo.
- [ ] iPhone com "Reduzir Movimento" ligado: só imagem + botão; nada baixa antes do toque.
- [ ] iPhone com Chrome/Firefox iOS (WebKit) e iPad (retrato/paisagem).
- [ ] Android Chrome (com e sem "Economia de dados"), Samsung Internet e Firefox Android.
- [ ] Rede lenta real (4G fraco): a imagem aparece primeiro; o vídeo entra depois ou não entra, sem travar a página.
- [ ] Desktop: Chrome, Edge, Firefox e Safari; janela redimensionada e rotação.
- [ ] Verificar no PageSpeed/Lighthouse (celular) que LCP e CLS não pioraram.
