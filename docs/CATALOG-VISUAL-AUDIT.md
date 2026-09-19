# Auditoria visual do catálogo

Base: `origin/main` em `ab4a6af`. Escopo: apresentação pública; nenhum serviço, banco, regra comercial ou configuração de produção.

## Mapa antes da implementação

- `/pecas/page.tsx`: busca e categorias no servidor; cards duplicados em relação a `ProductCard`.
- `/pecas/[handle]/page.tsx`: fotos empilhadas, informações e escolha entre `RentalCalendar` e `ValePassPresentation`.
- `CategorySelect`, `Header`, `CartDrawer`, `/carrinho/page.tsx`: filtros, navegação e carrinho.
- `RentalCalendar`: consulta, seleção, devolução e adição ao carrinho. Preservar funções e condições.
- `ValePassPresentation` e `lib/vale-pass-product.ts`: checkout próprio; preservar separação.
- `globals.css`: Tailwind, estilos editoriais e overrides públicos; `tailwind.config.ts`: paleta e fontes. Admin tem tema independente.
- `lib/cart.ts`, `checkout*.ts`, `rental-*.ts`, `shopify.ts`, API routes e `reservations-api`: fora do escopo de alteração.

## Evidência inicial e problemas

Capturas locais antes de editar: `artifacts/catalog-audit/before-{catalog,product}-{320,375,390,768,900,1024,1440}.png`.
Sem credenciais locais, foi utilizado o modo demonstrativo existente, com imagens ausentes. O endereço público encontrado na documentação respondeu 404; não foi possível validar fotografias reais da loja nesse endereço.

| Largura | Problemas identificados |
| --- | --- |
| 320–414 | Padding externo + painel + calendário reduz excessivamente a agenda; títulos e legendas muito pequenos; galeria inteira precede título/preço; controles do carrinho podem disputar a mesma linha. |
| 768–900 | Produto ainda usa coluna única; imagem muito alta; filtros ocupam várias linhas; falta composição própria de tablet. |
| 1024 | Duas colunas com gap de 56px e padding duplicado comprimem calendário. |
| 1440 | Container limitado a 1152px; espaço disponível mal distribuído; fotos adicionais continuam empilhadas. |
| Todos | `object-cover` corta imagens sem inspeção; sem lightbox, fallback de erro de imagem ou skeleton específico; cards duplicados não alinham títulos longos e preços; grid ARIA do calendário não contém rows/gridcells. |

## Estratégia definida antes de editar

1. Reutilizar `ProductCard` no catálogo, com variante editorial e alinhamento por linhas; preservar textos, preços e links.
2. Extrair galeria interativa: imagem inteira (`contain`), miniaturas, dialog nativo com Escape, foco restaurado e zoom. Usar apenas URLs recebidas e assets existentes.
3. Container fluido até 1440px; mobile com margens menores; tablet em duas colunas a partir de 768px, calendário com largura mínima útil; desktop com galeria maior.
4. Remover paddings acumulados da agenda; manter funções e critérios existentes. Melhorar apenas semântica, estados de foco e tamanho dos controles. CTA aderente à base durante a passagem pelo calendário.
5. Ajustar drawer e carrinho com safe area, quebra de conteúdo e controles de toque. Isolar CSS das áreas administrativas.
6. Verificar 320, 360, 375, 390, 414, 768, 820, 900, 1024 e 1440px; testar fluxos em fixtures locais sem criar reservas reais.

## Resultados

A preencher após a validação; capturas com fixtures serão identificadas como tal, sem apresentá-las como validação de produção.
