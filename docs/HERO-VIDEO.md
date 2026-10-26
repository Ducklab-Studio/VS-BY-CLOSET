# Vídeo do hero da home — como receber o vídeo do Orlando

**Estado atual:** nenhum vídeo recebido nem publicado. A home mostra só a imagem do hero. A estrutura abaixo já está pronta e testada; nada precisa mudar no código além de uma linha.

## Como ativar (quando o arquivo chegar e for aprovado)
1. Exportar o vídeo conforme a tabela abaixo e colocar em `apps/marketing/public/editorial/`: `hero.mp4` (obrigatório), `hero.webm` (opcional, recomendado) e `hero-poster.webp` (opcional; sem ele a imagem atual do hero faz o papel de poster).
2. Em `apps/marketing/src/lib/hero-media.ts`, trocar `HERO_VIDEO = null` pelo objeto do exemplo comentado no próprio arquivo.
3. PR, CI e publicação normais (nada de deploy sem autorização). Para **desligar**, voltar a constante para `null`.

## Exportação recomendada
| Item | Valor |
|---|---|
| Duração | 6–12 s, em loop contínuo (início e fim combinando) |
| Áudio | **nenhum** (remover a faixa; o vídeo é sempre mudo) |
| Resolução | 1920×1080 (máx.); versão 1280×720 também serve e pesa menos |
| MP4 | H.264, perfil High, 24–30 fps, ~3–5 Mbps, `faststart` (moov no início) |
| WebM | VP9, mesma resolução, ~2–3 Mbps |
| Peso alvo | **até ~4 MB** por arquivo (o poster/imagem aparece primeiro) |
| Enquadramento | o texto fica à esquerda: manter o assunto do centro para a direita (o corte usa `object-position: 67% center`) |
| Direitos | confirmar autorização de uso das imagens/pessoas e da trilha (se houver, que fique fora: o vídeo é mudo) |

Exemplo de conversão (ffmpeg): `ffmpeg -i origem.mov -an -vf scale=1920:-2 -c:v libx264 -profile:v high -crf 24 -pix_fmt yuv420p -movflags +faststart hero.mp4`

## O que o código faz (já testado)
- A **imagem do hero é sempre renderizada** (com prioridade) e fica por baixo como fallback; o vídeo aparece com fade só depois que começa a tocar.
- O `<video>` só é montado **depois do carregamento da página** (não atrasa o primeiro desenho), mudo, em loop, `playsInline`, `preload="metadata"`, `aria-hidden`.
- **Não carrega** com "reduzir movimento" ligado, economia de dados ativa ou conexão lenta (2g/3g). Nesses casos fica a imagem.
- **Pausa** quando o hero sai da tela ou a aba fica oculta e retoma ao voltar.
- Se o arquivo faltar ou o navegador não decodificar, o vídeo é descartado e a imagem continua (nenhum erro visível).
- Com `HERO_VIDEO = null` nenhum `<video>` entra na página.

Testes: `apps/marketing/test/hero-media.test.mjs` (regras e estrutura) e verificação manual em navegador com um vídeo sintético temporário (não commitado): monta só após o `load`, toca mudo em loop, pausa fora da tela, respeita "reduzir movimento" e volta à imagem quando o formato não decodifica.
