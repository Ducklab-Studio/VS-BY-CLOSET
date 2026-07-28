# Deploy em produção

O projeto roda como containers atrás de um proxy reverso com HTTPS automático.
Não há dependência de provedor específico: o mesmo `docker-compose.prod.yml`
sobe em Hostinger, Hetzner, DigitalOcean, Contabo, AWS EC2 ou qualquer VPS com
Docker.

```
Internet ──► Caddy :443 ──┬── /api/v1/*  ──► api  :3333 ──► postgres :5432
             (SSL auto)   │                          └───► redis    :6379
                          └── /*         ──► web  :3000
```

Só o Caddy publica porta. Postgres, Redis, API e Web ficam numa rede Docker
interna, inalcançáveis de fora.

---

## 1. Preparar o servidor

Requisitos: 2 vCPU, 4 GB de RAM, 40 GB de disco. Ubuntu 22.04 ou 24.04.

```bash
curl -fsSL https://get.docker.com | sh
```

```bash
sudo usermod -aG docker $USER && newgrp docker
```

Libere as portas 80 e 443. A 80 precisa ficar aberta mesmo em site só-HTTPS —
é por ela que o Let's Encrypt valida o domínio.

```bash
sudo ufw allow 22,80,443/tcp && sudo ufw enable
```

## 2. Apontar o domínio

No painel de DNS, crie dois registros apontando para o IP do servidor:

| Tipo | Nome  | Valor            |
| ---- | ----- | ---------------- |
| A    | `@`   | `IP_DO_SERVIDOR` |
| A    | `www` | `IP_DO_SERVIDOR` |

Confirme a propagação antes de seguir — o Caddy não emite certificado se o DNS
ainda não resolver:

```bash
dig +short loja.com.br
```

## 3. Configurar as variáveis

```bash
git clone <seu-repo> /opt/loja && cd /opt/loja && cp .env.production.example .env
```

Gere os segredos (cada um precisa ser diferente do outro):

```bash
echo "POSTGRES_PASSWORD=$(openssl rand -base64 32)"; echo "JWT_ACCESS_SECRET=$(openssl rand -base64 48)"; echo "JWT_REFRESH_SECRET=$(openssl rand -base64 48)"
```

Cole os valores no `.env` junto com `DOMAIN` e `ACME_EMAIL`.

> A API **se recusa a subir** se algum segredo estiver com valor de exemplo, se
> os dois segredos JWT forem iguais, ou se a `DATABASE_URL` não tiver SSL em
> produção. Um deploy que não sobe é melhor do que um deploy inseguro.

## 4. Subir

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

Na primeira vez, popule o banco com o usuário admin e o catálogo de exemplo:

```bash
RUN_SEED=true docker compose -f docker-compose.prod.yml up -d --force-recreate api
```

Troque a senha do admin no primeiro login.

## 5. Verificar

```bash
curl https://loja.com.br/api/v1/health/ready
```

Resposta esperada: `{"status":"ok","db":"up","latencyMs":3}`

```bash
docker compose -f docker-compose.prod.yml ps
```

Todos os serviços devem aparecer como `healthy`.

---

## Atualizações

```bash
git pull && ./scripts/deploy.sh
```

O script faz backup do banco antes de qualquer coisa, reconstrói as imagens e
só reporta sucesso depois que os healthchecks passam. As migrações são
aplicadas automaticamente pelo entrypoint da API.

## Backup

```bash
./scripts/backup.sh
```

Agende no cron do host:

```bash
0 3 * * * cd /opt/loja && ./scripts/backup.sh >> /var/log/loja-backup.log 2>&1
```

Backups ficam em `./backups`, com retenção de 14 dias. Se `S3_BUCKET` estiver
configurado e a AWS CLI instalada, cada dump é replicado no bucket — backup
guardado só no mesmo servidor não protege contra perda da máquina.

Para restaurar:

```bash
gunzip -c backups/loja-AAAAMMDD-HHMMSS.sql.gz | docker compose -f docker-compose.prod.yml exec -T postgres psql -U loja -d loja
```

---

## Upload de imagens (Cloudflare R2)

Sem object storage o painel aceita apenas URL de imagem colada. Container não
guarda arquivo: qualquer upload salvo em disco local some no próximo deploy.

1. No painel da Cloudflare: **R2 → Create bucket** (ex: `loja-midia`).
2. **Settings → Public access → Connect domain** → `cdn.loja.com.br`.
3. **Manage R2 API Tokens → Create** com permissão _Object Read & Write_.
4. Preencha no `.env`:

```bash
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=loja-midia
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_PUBLIC_URL=https://cdn.loja.com.br
```

5. Aplique o CORS no bucket — o navegador envia direto para lá:

```json
[
  {
    "AllowedOrigins": ["https://loja.com.br"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type"],
    "MaxAgeSeconds": 3600
  }
]
```

6. Recarregue a API:

```bash
docker compose -f docker-compose.prod.yml up -d api
```

O binário nunca passa pela API — o navegador recebe uma URL pré-assinada e
envia direto ao bucket. A API não vira gargalo de banda e não precisa de disco.

---

## Escalar horizontalmente

```bash
docker compose -f docker-compose.prod.yml up -d --scale api=3
```

Dois cuidados:

- **`RUN_MIGRATIONS`**: com várias réplicas subindo juntas, deixe `false` e rode
  as migrações uma vez antes do deploy, para não disputar o lock do Prisma.
- **Redis é obrigatório** (já incluso). Sem ele o rate limit fica em memória e
  cada réplica conta separado — o limite efetivo se multiplica pelo número de
  instâncias. A validação de ambiente bloqueia essa combinação.

Para volume maior, troque o Postgres do compose por um gerenciado (Neon,
Supabase, RDS): ajuste `DATABASE_URL` e remova o serviço `postgres`.

---

## Outras plataformas

O código é agnóstico. Em serviços que constroem a partir do Dockerfile
(Railway, Render, Fly.io), suba **dois** serviços do mesmo repositório:

| Serviço | Dockerfile            | Variáveis principais                                          |
| ------- | --------------------- | ------------------------------------------------------------- |
| api     | `apps/api/Dockerfile` | `DATABASE_URL`, `REDIS_URL`, segredos JWT, `TRUST_PROXY=true`  |
| web     | `apps/web/Dockerfile` | `API_INTERNAL_URL` apontando para a URL interna da API         |

Se a plataforma não permitir rota compartilhada entre os dois serviços, o modo
de mesmo domínio não se aplica. Nesse caso:

```bash
# serviço web
NEXT_PUBLIC_API_URL=https://api.loja.com.br
# serviço api
SAME_ORIGIN_PROXY=false
CORS_ORIGIN=https://loja.com.br
COOKIE_SAMESITE=none
COOKIE_SECURE=true
```

Vale saber o custo dessa escolha: com `sameSite=none` o cookie de refresh vira
cookie de terceiros, e Safari e Brave bloqueiam por padrão — a sessão desses
usuários passa a expirar em 15 minutos em vez de 7 dias. Por isso o padrão é o
proxy de mesmo domínio.

---

## Diagnóstico

| Sintoma                            | Causa provável                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| API reinicia em loop               | Veja `docker compose logs api`: a validação de ambiente imprime qual variável está errada.   |
| Certificado não emite              | DNS não propagou ou porta 80 fechada. Cheque com `dig +short seu-dominio`.                   |
| Login funciona mas desloga sozinho | Cookie de refresh rejeitado. Confira `COOKIE_SAMESITE` e `COOKIE_SECURE`.                    |
| 429 em uso normal                  | `RATE_LIMIT_MAX` baixo, ou `TRUST_PROXY` desligado (todo mundo conta como um IP só).         |
| Upload falha com erro de CORS      | Falta a regra de CORS no bucket (passo 5 acima).                                             |
| `did not initialize yet` do Prisma | Imagem construída sem `prisma generate`. Reconstrua com `--no-cache`.                        |
