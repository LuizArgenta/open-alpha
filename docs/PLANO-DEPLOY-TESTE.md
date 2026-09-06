# Plano de deploy — versão de teste

Como pôr o Open Alpha no ar para um teste **com adultos consentindo**, em VPS com Docker e Coolify.

Este documento existe porque o [plano de execução](./PLANO-DE-EXECUCAO.md) é organizado por qualidade de código, e "colocar no ar" expõe um conjunto diferente de lacunas — configuração, custo, perda de dado, saber que quebrou.

**Escopo deliberado:** adultos. Nenhum menor. Isso tira do caminho crítico a LGPD-para-menores com RIPD, a revisão jurídica e o pentest, e transforma os itens 13b/14/15 de bloqueantes em desejáveis. Se em algum momento uma criança for usar isto, este documento **não é mais suficiente** — volte ao plano de execução.

---

## O que foi resolvido para tornar isto deployável

### Havia dois backends, e o errado parecia o pronto para Docker

| | `api/` | `backend/src/` (removido) |
|---|---|---|
| Commits | 44 | 2 |
| Último toque | setembro | **14/03/2026** |
| Forma | funções Vercel (`Request`→`Response`) | Express + better-sqlite3 |

Todo o trabalho de integridade — correção da prova no servidor, transações, banco de itens, migrações versionadas, rate limiting, varredura de IDOR — está em `api/`. O `backend/` não tinha nada disso, e em `routes/tutor.ts` aceitava `score`, `totalQuestions` e `correctAnswers` **do corpo da requisição**: exatamente a vulnerabilidade que o PR #20 fechou, o item 1 do plano.

O risco não era teórico: só o `backend/` tinha `build`/`start` e um Express escutando porta. Uma configuração de Coolify pelo caminho óbvio — "é Node, tem `npm start`" — subiria o backend com a nota declarada pelo navegador. **Removido.** O git preserva o histórico; nada exclusivo se perdeu (a integração ATXP existe nos dois, em `api/auth/atxp-*.ts` e `api/_lib/llm.ts`).

### O `api/` não tinha como rodar fora da Vercel

Na Vercel, o caminho do arquivo **é** a rota, e o repositório nunca escreveu esse mapeamento porque a plataforma o fornecia. `server/routes.ts` o escreve, e `server/index.ts` serve as duas metades num processo só, reproduzindo o que o `vercel.json` descreve: `/api/*` para os handlers, todo o resto para o shell do SPA.

Os handlers não foram tocados. Eles leem caminho, query e corpo do próprio `Request`, então nada aqui interpreta requisição em nome deles — não há uma segunda interpretação para divergir da primeira.

---

## Variáveis de ambiente

O servidor **recusa subir** sem as obrigatórias, com todas as faltantes listadas de uma vez (uma por vez significaria um deploy falho por variável).

| Variável | Obrigatória | Para quê |
|---|---|---|
| `JWT_SECRET` | **sempre** | assina os tokens de sessão |
| `TURSO_DATABASE_URL` | **em produção** | onde o banco vive — veja o aviso abaixo |
| `TURSO_AUTH_TOKEN` | só com Turso remoto | credencial do Turso |
| `ADMIN_INIT_KEY` | para criar o 1º admin | sem ela não há como conceder o primeiro papel de staff |
| `CURRICULUM_REQUIRE_DATABASE` | não | **agora liga sozinha em produção** |
| `NODE_ENV=production` | **sim** | é o que ativa os padrões seguros acima |
| chaves de LLM | para lição/prova gerada | 94% dos conceitos dependem disso |

**O aviso que mais importa:** sem `TURSO_DATABASE_URL`, o padrão é `file:local.db` — *dentro do contêiner*. Funciona até o primeiro redeploy levar junto todas as contas e todas as tentativas. Aponte para um volume: `file:/data/open-alpha.db`. O servidor avisa no boot se o caminho for relativo em produção.

`CURRICULUM_REQUIRE_DATABASE` era opt-in e desligada por padrão — o achado P1.4 da segunda auditoria. Esquecê-la em produção servia os arquivos-semente com aviso só em log, que é precisamente a falha silenciosa que o item 5 existiu para acabar. Agora ela **liga por padrão quando `NODE_ENV=production`**; desligar continua possível e passa a ser deliberado.

---

## Deploy no Coolify

1. Aplicação do tipo **Dockerfile**, apontando para a raiz do repositório.
2. **Volume persistente** montado em `/data`.
3. Variáveis conforme a tabela, com `TURSO_DATABASE_URL=file:/data/open-alpha.db`.
4. **Healthcheck**: `GET /api/health/schema`. Ele responde **503 enquanto uma migração não terminou**, então o orquestrador distingue "subindo" de "no ar" — e não manda tráfego para um schema pela metade. O `Dockerfile` já declara um `HEALTHCHECK` equivalente.
5. Primeiro boot: as migrações rodam sozinhas. **Importe o currículo** em seguida — sem isso, com `CURRICULUM_REQUIRE_DATABASE` ligada, a instância recusa servir em vez de mentir.
6. Crie o primeiro admin com a `ADMIN_INIT_KEY` e **remova a variável** depois.

---

## O que ainda falta antes de abrir para os testadores

Em ordem de risco:

1. **Backup e restauração testados** (item 31). Com SQLite num volume isso é simples e não há desculpa. O plano já dizia "antes do piloto, não depois" — se o dado do teste sumir, o teste sumiu junto.
2. **Teto de gasto de LLM e chave de desligamento.** O `demo/chat.ts` é anônimo, chama modelo, e limita por IP de cabeçalho spoofável (achado do PR #40). **Recomendação: desligar o modo demo neste teste** — é a maior superfície de custo e de abuso, e não testa o laço de aprendizagem.
3. **PR #40** (rate limiting no login) mesclado.
4. **Item 14**, sessão revogável. Dos três de auth restantes, é o único que eu faria mesmo para adultos: não conseguir revogar sessão é ruim se alguém perde o laptop. O **13b** (Argon2id) não é o elo fraco — bcrypt(10) aguenta um teste fechado. O **15** (cookie HttpOnly) o plano manda fazer isolado; **adiar**.
5. **Aviso de dados**, em texto simples. Não é LGPD-para-menores, mas adulto também tem direito de saber o que é coletado.

---

## Duas coisas que os testadores vão encontrar

**`/api/progress/gamification` não existe.** O `StudentDashboard` chama e não confere a resposta, então falha em silêncio — isso já acontece na Vercel hoje. O endpoint só existia no backend removido. Precisa ser reescrito contra `api/` antes que o painel mostre o que quer que ele mostrasse. `tests/server-routing.test.ts` fixa essa lacuna: o teste quebra se ela crescer, e quebra de novo quando ela for fechada.

**9 de 141 conceitos têm banco de itens autorado.** Nos outros 94% a prova é gerada por LLM a cada tentativa — funciona, mas custa, varia, e é onde a auditoria achou a "prova impossível de passar". Se você quer testar o conteúdo real, **direcione os testadores aos 9 conceitos autorados**. Fora deles, o que está sendo testado é geração.

---

## Fora de escopo, e por quê

LGPD-para-menores com RIPD, revisão jurídica, pentest, itens 19–24 (algoritmos adaptativos), Console de Guide, turmas, padrões 1EdTech. Nada disso bloqueia validar o laço de tutor com adultos consentindo — e o item 20 em particular não renderia nada, porque exige pool bem maior que os 5 itens mínimos de hoje.
