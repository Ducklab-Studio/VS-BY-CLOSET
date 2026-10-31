# IP confiável atrás da Railway — situação, riscos e validação segura

## O que o código faz hoje
- `apps/reservations-api/src/client-ip.ts`: na Railway (`RAILWAY_DEPLOYMENT_ID` presente) vale o `X-Real-IP` da borda **se for um endereço PÚBLICO**; senão (ausente, inválido, loopback, rede privada, CGNAT `100.64/10`, link-local, multicast) vale o endereço da conexão. Fora da Railway nenhum cabeçalho de IP é usado. O `X-Forwarded-For` **nunca** é lido. `app.set('trust proxy', 1)` existe, mas as chaves do limite não dependem dele.
- Limite global: 100/min por IP confiável. Escritas públicas (reservas): 10/min.
- **Rotas administrativas sensíveis do Valle Pass (saldo, resgate, reversão, bloqueio)** passam a contar por **sessão administrativa** (`admin/admin-session-throttle.ts`): independe de qualquer cabeçalho de IP e só aceita o token de sessão como chave quando a chamada traz também o token interno do servidor do site (que nunca chega ao navegador); sem ele, conta pela conexão. Enumerar códigos exige sessão válida **e** gasta o limite dela.

## O que se sabe sobre a Railway (fontes públicas; a documentação oficial descreve o comportamento original)
A confiança no `X-Real-IP` **não é garantida**: relatos recentes (a partir de ~fev/2026) mostram `X-Real-IP` com IPs da própria Railway/Fastly e respostas da equipe divergentes sobre se a borda sobrescreve cabeçalhos do cliente e qual posição do `X-Forwarded-For` é confiável. Referências: [Which client-address headers does the Railway edge set, and are caller copies replaced?](https://station.railway.com/questions/which-client-address-headers-does-the-ra-fb9e36d7), [Edge Proxy X-Forwarded-For and X-Real-Ip can't be trusted](https://station.railway.com/questions/edge-proxy-x-forwarded-for-and-x-real-ip-c5a50049), [Supported trust model for client IP headers behind Railway HTTP ingress](https://station.railway.com/questions/supported-trust-model-for-client-ip-head-aafb68bc), [There is no more real client IpAddress in headers](https://station.railway.com/questions/there-is-no-more-real-client-ip-address-i-5bcc9d43). **Conclusão:** nenhuma decisão de segurança financeira pode depender do IP; ele só serve para amortecer abuso anônimo.

## Impacto
- Enumeração de códigos de voucher e resgate: **não** dependem de IP (exigem sessão administrativa + limite por sessão).
- Se `X-Real-IP` for forjável, o limite **por IP** das rotas públicas (reservas/disponibilidade) é contornável, o que permite no máximo abuso de estoque temporário (holds expiram) — sem perda financeira direta.

## Validação segura (sem teste invasivo, sob autorização)
Rota **desligada por padrão**: `GET /diagnostics/client-ip` (404 sem `CLIENT_IP_DIAGNOSTIC=on`), só descreve a **própria** requisição (IP derivado, origem, se o `X-Real-IP` veio/é público, quantos saltos de `X-Forwarded-For` — nunca os valores, nenhum cabeçalho de autenticação). Procedimento (janela curta, **[AUTORIZAÇÃO]** para ligar/desligar a variável na Railway):
1. Ligar `CLIENT_IP_DIAGNOSTIC=on`; abrir a rota no navegador e comparar `derivedIp` com o IP público de quem abriu (ex.: pelo celular em 4G).
2. Repetir com `curl -H "X-Real-IP: 1.2.3.4" -H "X-Forwarded-For: 5.6.7.8" <url>`: `derivedIp` **igual ao IP real** = a borda sobrescreve; **igual a 1.2.3.4** = cabeçalho forjável (limite por IP contornável nas rotas públicas).
3. Se `source` vier `socket` com IP interno (100.64.x.x) em todas as chamadas, a borda não entrega o IP do visitante: todo o tráfego cai num único balde (mais restritivo, nunca mais permissivo).
4. Desligar a variável e registrar o resultado.
Alternativa permanente, se a Railway não garantir o cabeçalho: colocar um CDN/WAF (ex.: Cloudflare) na frente e confiar só no cabeçalho dele, **ou** manter o limite por IP apenas como amortecedor e proteger as rotas sensíveis por identidade (como feito aqui).
