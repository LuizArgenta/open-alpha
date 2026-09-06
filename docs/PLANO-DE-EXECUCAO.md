# Plano de execução

Quadro de acompanhamento do que falta para o Open Alpha ser usável de verdade por uma escola. Deriva da auditoria de 5 de setembro de 2026 cruzada com o estado real do código, e de uma segunda auditoria complementar (mesma data) que revisou o que os PRs #20 e #22–#27 efetivamente mudaram no banco e na concorrência.

**Como manter:** marque a caixa quando o PR for **mergeado**, não quando for aberto, e anote o número do PR ao lado. Se um item se revelar desnecessário ou mudar de forma, edite a linha e diga por quê — um item riscado sem explicação vira dúvida daqui a três meses.

Documentos relacionados: [PRD v1 — motor adaptativo](./PRD-adaptive-learning-engine.md) · [PRD v2 — evidência, autoria e motivação](./PRD-plataforma-de-aprendizagem.md)

---

## Onde estamos

*Atualizado em 5 de setembro de 2026.*

Mergeado em `main` (PRs #1 a #19): motor de decisão com volta ao pré-requisito, revisão espaçada, diagnóstico do tipo de erro, medidor de foco contestável, validação de lição gerada, alertas ao responsável, XP ligado a prova de aprendizagem, evidência de avaliação, log de decisões, linha do tempo, override humano, nivelamento, currículo no banco, autoria de matérias e árvores, pt-BR como padrão e CI.

Mergeado depois disso, os **seis primeiros itens do Marco 1**: [#20](https://github.com/LuizArgenta/open-alpha/pull/20) correção da prova no servidor, [#22](https://github.com/LuizArgenta/open-alpha/pull/22) transação única na submissão e expiração de tentativa, [#23](https://github.com/LuizArgenta/open-alpha/pull/23) fim do fallback silencioso, [#24](https://github.com/LuizArgenta/open-alpha/pull/24) leitura de currículo endurecida, [#25](https://github.com/LuizArgenta/open-alpha/pull/25) invalidação do cache de currículo, [#26](https://github.com/LuizArgenta/open-alpha/pull/26) nivelamento no modelo de tentativa.

Da segunda auditoria, já mergeados: [#28](https://github.com/LuizArgenta/open-alpha/pull/28) headers de segurança (item 17), [#29](https://github.com/LuizArgenta/open-alpha/pull/29) binding de parâmetros SQL por número (item 7) — descascou e corrigiu de quebra um segundo bug real que o binding antigo escondia no `UPDATE progress` de `submit.ts` —, e [#31](https://github.com/LuizArgenta/open-alpha/pull/31) equivalência de constraint em `assessment_responses` entre banco novo e migrado (item 8).

**221 testes**, contra 160 quando este plano foi escrito.

**Segunda auditoria (mesma data):** comparando os PRs #20 e #22–#26 com o código mesclado (não só com a descrição dos PRs), os itens 2 e 4 não estão integralmente fechados — ficam em **~85%**. Quatro problemas de fundo, todos confirmados lendo `api/_lib/db.ts`, `api/_lib/assessment.ts` e `api/tutor/quiz/submit.ts` diretamente:

1. `executeSql` e `toLibsqlStatement` ligam `$1`, `$2`... aos parâmetros pela ordem em que aparecem no SQL, não pelo número capturado — um placeholder repetido consome um argumento a menos e pode gravar na coluna errada sem erro. Já registrado abaixo em "O que apareceu no caminho"; vira item formal (**7**).
2. A finalização da prova (`submit.ts`) confere `finished_at IS NULL` **antes** de abrir a transação, e o `UPDATE` dentro dela não repete essa condição — duas submissões simultâneas da mesma tentativa podem conceder XP em dobro, incrementar `attempts` duas vezes e duplicar as decisões (**item 9**, fecha o que o item 2 deixou aberto).
3. `assessment_responses` tem `UNIQUE(attempt_id, item_id)` na criação nova, mas a migração que roda em banco **já existente** recria a tabela com `CREATE TABLE IF NOT EXISTS` sem essa restrição — instalação anterior ao PR #20 continua sem a proteção, e os testes só cobrem banco novo (**item 8**).
4. `storeItem` reaproveita um item autorado pelo mesmo `authoredId` sem comparar conteúdo — se a questão for editada mantendo o id, o aluno vê o enunciado novo (lido do currículo atual) mas é corrigido pelo `correct_answer` do registro antigo em `assessment_items` (**item 10**, fecha o que o item 4 deixou aberto).

Nenhum desses quatro é hipotético: todos foram lidos linha a linha no código atual, não inferidos da descrição dos PRs. Eles precedem os itens 7 a 12 originais (agora 13 a 18) na fila.

**O que isso ainda não é:** uma plataforma segura para uso real por menores, nem uma com garantias de integridade de dados acadêmicos invariantes sob concorrência ou migração. Nenhum aluno real antes de fechar os itens 7 a 12 (integridade) e 13 a 18 (segurança).

---

## Marco 1 — Integridade e segurança

Nada aqui é opcional antes de colocar um aluno real no sistema.

- [x] **1. Corrigir a prova no servidor** — PR #20. A nota era declarada pelo navegador e o gabarito era enviado para a página.
- [x] **2. Transação única na submissão** *(parcial — ver item 9)* — PR #22. `executeTransaction` no `db.ts`; a submissão decide tudo antes de escrever e escreve uma vez, com as decisões dentro da transação. Tentativa expira em 2h, varrida na próxima prova que o aluno abre. **O que falta:** o `UPDATE` que fecha a tentativa não repete `finished_at IS NULL` dentro da transação — duas submissões concorrentes da mesma tentativa passam as duas pela checagem feita antes de abrir a transação e as duas escrevem. Fechado pelo item 9.
- [x] **3. Mesmo modelo de tentativa no nivelamento** — PR #26. Fechou um buraco não previsto: o conceito ao qual cada resposta contava vinha do cliente.
- [x] **4. Endurecer a leitura do currículo** *(parcial — ver item 10)* — PR #24. Validação por registro, importação transacional, hash de conteúdo. Achou também a prova impossível de passar: resposta que não casa com nenhuma opção. **O que falta:** isso valida o currículo lido do JSON/banco, não o item já persistido em `assessment_items` — `storeItem` reaproveita o registro antigo pelo `authoredId` sem comparar conteúdo, então editar uma questão autorada sem trocar o id deixa alunos respondendo um enunciado novo contra um gabarito antigo. Fechado pelo item 10.
- [x] **5. Fim do fallback silencioso** — PR #23. `curriculumStatus`, `GET /api/health/curriculum` respondendo 503, aviso na página de admin, e `CURRICULUM_REQUIRE_DATABASE` para recusar servir os arquivos.
- [x] **6. Invalidação do cache de currículo** — PR #25. Revisão derivada (ninguém precisa lembrar de incrementar) e refresh em segundo plano; publicar força a instância que atendeu.
- [x] **7. Corrigir o binding de parâmetros SQL ($N)** *(P)* — [PR #29](https://github.com/LuizArgenta/open-alpha/pull/29). `executeSql` e `toLibsqlStatement` (`db.ts`) agora ligam por `params[Number(number) - 1]` numa função só, e lançam erro em vez de ligar silenciosamente quando falta argumento. Varredura no repositório não achou consulta que dependesse do comportamento antigo — mas a suíte completa achou uma direta: o `UPDATE progress` em `submit.ts` tinha `$4/$5/$6` fixos no `WHERE` que só coincidiam com a posição certa quando havia `schedule`; corrigido numerando os placeholders a partir de um contador. Prova viva de por que o binding por posição era perigoso.
- [x] **8. Garantir equivalência entre banco novo e banco migrado** *(M)* — [PR #31](https://github.com/LuizArgenta/open-alpha/pull/31). `ensureAssessmentResponsesUniqueConstraint` (`db.ts`) checa `PRAGMA index_list` e, se a constraint não existe, deduplica respostas existentes (mantém a mais antiga por `attempt_id, item_id`) e cria o índice único, retroativo em qualquer instalação. Rodada a cada boot, mas barata: sai no primeiro check quando já está em dia. **Escopo:** cobre o achado específico da auditoria (`assessment_responses`); um diff de schema genérico entre banco novo e migrado, cobrindo toda tabela, fica para o item 12 (migrações versionadas), que é o lugar estrutural certo para isso.
- [ ] **9. Tornar a finalização da tentativa concorrente-segura e idempotente** *(M)* — completa o item 2. Preferência: tabela `assessment_attempt_finalizations` com `attempt_id` como chave primária, `INSERT` dela como primeira instrução da transação — uma segunda finalização viola a chave e reverte tudo. Alternativa: `UPDATE ... WHERE id = ? AND finished_at IS NULL RETURNING id` dentro da transação, seguir só se uma linha mudou. Teste com duas submissões via `Promise.all`: uma única resposta de sucesso, um único XP, um único incremento de `attempts`.
- [ ] **10. Versionar itens autorados como snapshots imutáveis** *(M)* — completa o item 4. Tratar `assessment_items` como snapshot: `content_hash` além de `authored_id`, novo item quando enunciado/alternativas/gabarito/explicação mudar, nunca atualizar retroativamente um item já ligado a tentativas. Teste: editar o conteúdo sem trocar `authoredId` cria um `assessment_item` novo; tentativas antigas continuam lendo o snapshot antigo; o conteúdo mostrado ao aluno bate byte a byte com o snapshot usado na correção.
- [ ] **11. Tornar `openAttempt` transacional** *(P)* — hoje grava itens, depois a tentativa, depois os vínculos em `executeSql` separados (`assessment.ts`); uma falha no meio deixa itens órfãos ou tentativa incompleta. Uma transação só, e recusar tentativa com zero itens ou vínculo incompleto.
- [ ] **12. Criar migrações versionadas e parar de engolir erros** *(M)* — `initializeSchema` roda cada `ALTER TABLE` num `try/catch` que descarta qualquer exceção como "coluna já existe" — inclusive erro de permissão, conexão, corrupção ou constraint. Criar `_schema_migrations` (id, checksum, data), ignorar só os códigos de erro esperados, falhar o health check se uma migração necessária não terminar.
- [ ] **13. Argon2id, rate limiting e anti-enumeração** *(M)* — bcrypt com 10 rounds hoje; login e cadastro sem limite de tentativas.
- [ ] **14. Sessão: token curto, rotação, revogação, logout global** *(M)* — hoje o token vale 7 dias e não há como revogar.
- [ ] **15. Sair do localStorage para cookie HttpOnly + CSRF** *(G)* — **fazer isolado.** Toca toda chamada autenticada do frontend; um erro aqui derruba o login de todo mundo.
- [ ] **16. Varredura de IDOR/BOLA** *(M)* — feito para pai/filho e tentativas; falta progresso, sessões, interesses e coach.
- [x] **17. CSP, HSTS, frame-ancestors, CORS explícito** *(P)* — [PR #28](https://github.com/LuizArgenta/open-alpha/pull/28). `vercel.json` passa a enviar CSP (`default-src 'self'`, sem `unsafe-inline` nem wildcard), HSTS com preload, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy` e `Permissions-Policy` em toda resposta, com teste de regressão em `tests/security-headers.test.ts`. O `Access-Control-Allow-Origin: *` citado aqui **não era o problema**: `api/curriculum/lesson.ts` e os outros seis endpoints com o mesmo header (`curriculum/graph`, `curriculum/gaps`, `contribute/lesson`, `contribute/quiz`, `quality/review`, `quality/review-queue`) são de propósito público — conteúdo do currículo e a API de contribuição para agentes, documentados como tal no próprio arquivo. Nenhum endpoint com dado privado ou autenticado usa CORS aberto hoje.
- [ ] **18. Dependabot, CodeQL, secret scanning, actions fixadas por SHA** *(P)* — `ci.yml` usa `actions/checkout@v4` e `actions/setup-node@v4` (tags, não SHA). Fixar por SHA, habilitar Dependabot e CodeQL, secret scanning com push protection, dependency review, SBOM por release, proteger `main` contra force-push/exclusão e exigir CI + revisão antes do merge — metade é configuração de repositório, fora de PR.

## Marco 2 — Tutor local confiável

- [ ] **19. Banco de itens** *(G)* — pool por habilidade em vez de 5 questões fixas, com dificuldade, distratores ligados a erros conhecidos e versão do item registrada em cada tentativa. **Destrava 20, 21 e 23.**
- [ ] **20. Seleção de itens** *(M)* — não repetir item recente, limitar exposição, sortear por dificuldade. Depende do 19.
- [ ] **21. Nivelamento adaptativo** *(G)* — próxima questão escolhida pelas anteriores, regra estatística de parada, intervalo de confiança, retomada em outro dia. Depende do 19.
- [ ] **22. Geração de lições em lote para árvores novas** *(M)* — item C5 do PRD v2, não entregue. ⚠️ Não verificável sem credenciais ATXP.
- [ ] **23. Modelo probabilístico de domínio** *(G)* — BKT ou Elo educacional, com incerteza e decaimento. ⚠️ **Adiar até haver dados reais:** calibrar sem alunos é ajustar parâmetros no vácuo.
- [ ] **24. Planejador diário de atividades** *(G)* — fila misturando novidade, revisão e remediação. Só vale a pena depois do 23.

## Marco 3 — Operação com vários alunos

- [ ] **25. LGPD e proteção de menores** *(G)* — retenção por categoria, exportação, exclusão, aviso de privacidade em linguagem infantil e adulta, RIPD. **Não pode ser posterior num produto para menores.** Dividir em entregas técnicas menores (retenção, exportação, exclusão, aviso) em vez de um PR só; a revisão jurídica em si fica fora de PR (ver "Fora de PR").
- [ ] **26. Log de auditoria append-only** *(M)* — logins, mudanças de papel, publicações e acessos administrativos a dados infantis.
- [ ] **27. Console de Guide** *(G)* — fila de intervenções priorizadas, histórico, notas privadas, acordos com o aluno, separação entre observação e inferência algorítmica.
- [ ] **28. Turmas, grupos e matrículas** *(M)* — uma escola não é um conjunto de famílias avulsas.
- [ ] **29. Painel do responsável completo** *(M)* — metas, limites de uso, exportação, controle de compartilhamento.
- [ ] **30. Telemetria e observabilidade** *(M)* — schema único de eventos, painel de saúde, alerta de backup vencido.
- [ ] **31. Backup e restauração testados** *(M)* — inclui teste de recuperação, não só de geração. **Antecipar para antes do piloto local** (ver Sequência recomendada), junto do item 33 — não é algo que se instala depois que já há aluno usando o sistema.

## Marco 4 — Plataforma equivalente

- [ ] **32. API versionada, OpenAPI, erros padronizados** *(M)* — o VISION.md promete "API-first" desde o início.
- [ ] **33. Distribuição local** *(G)* — Docker reproduzível, modo offline, LLM local por API compatível, chave de bloqueio de tráfego externo. **Antecipar para antes do piloto local**, junto do item 31.
- [ ] **34. Padrões 1EdTech** *(G)* — OneRoster, CASE, QTI, Caliper.
- [ ] **35. Aplicativos por matéria** *(XG)* — editor matemático com rascunho e passos, leitor com fluência, editor de texto com rubricas, simulações. **É aqui que mora a diferença real para a Alpha, e cada matéria é praticamente um produto.**

---

## Fora de PR

Precisam de alguém que não é o time de engenharia:

- **Mapear os ~141 conceitos para a BNCC** — trabalho pedagógico, precisa de professor.
- **Revisão jurídica** da LGPD e da Lei 15.211/2025 — precisa de advogado.
- **Pentest** antes de operar com menores, e **validação educacional independente** — precisam de terceiros.
- **Branch protection e revisão obrigatória** — configuração do repositório.

---

## Sequência recomendada

1. ~~**Antes:** 2 → 5 → 4 → 6 → 3.~~ **Feito** (PRs #22 a #26) — mas a segunda auditoria achou que "feito" era otimista sobre concorrência e versionamento. Revisado abaixo.
2. **Agora, nesta ordem — nenhum algoritmo novo antes disso:**
   1. **7** — binding de `$N` (afeta toda query com parâmetros; risco cresce a cada endpoint novo). ✅ PR #29.
   2. **8** — constraints equivalentes em banco novo × migrado. ✅ PR #31.
   3. **9** — finalização da tentativa concorrente-segura e idempotente.
   4. **10** — snapshots imutáveis dos itens autorados.
   5. **11** — `openAttempt` transacional.
   6. **12** — migrações versionadas, parar de engolir erros.
3. **Depois, segurança de custo baixo e risco alto:** 17 (✅ PR #28) → 18 → 16 → 13.
4. **Sessão:** 14, depois **isolado** o 15 (cookie HttpOnly + CSRF), por tocar toda chamada autenticada.
5. **Antes do piloto local, não depois:** 33 (distribuição local reproduzível) e 31 (backup e restauração testados) — instalar isso depois que já há aluno usando o sistema é tarde demais.
6. **LGPD (25) não espera** — corre em paralelo às entregas técnicas acima, dividida em pedaços pequenos; a revisão jurídica em si segue fora de PR.
7. **Só então** 19 em diante (banco de itens e algoritmos adaptativos) — sem isso, nivelamento e modelo probabilístico ficam limitados pelo dado, não pelo algoritmo, e não vale a pena otimizar um algoritmo sobre uma base ainda instável na 1 a 6.

## Definição de pronto

Chamar isto de substituto local acadêmico exige, da auditoria original e da complementar:

- [x] Toda nota calculada no servidor *(PR #20)*
- [ ] Todo domínio reconstruível a partir das evidências *(parcial — PRs #20, #22, #26 guardam item, resposta e decisão, mas o item respondido não é um snapshot imutável: ver item 10)*
- [ ] Toda tentativa vinculada a aluno, finalidade e snapshot imutável dos itens *(item 10)*
- [ ] Submissões simultâneas produzem exatamente um resultado *(item 9)*
- [x] Banco novo e banco migrado têm constraints equivalentes para `assessment_responses` *(item 8, PR #31 — genérico para toda tabela fica no item 12)*
- [ ] Falha intermediária em qualquer escrita composta provoca rollback integral *(itens 11, 12)*
- [ ] Migração inesperadamente defeituosa interrompe a inicialização em vez de seguir silenciosa *(item 12)*
- [ ] Currículo-alvo completo e revisado
- [ ] Atividades escolhidas por domínio e incerteza
- [ ] Funciona sem dependência obrigatória de nuvem *(item 33)*
- [ ] Responsáveis podem supervisionar, contestar e excluir dados
- [ ] Backup e restauração testados *(item 31, antes do piloto)*
- [ ] Auditoria e resposta a incidentes *(item 26)*
- [ ] Autorização verificada em todo endpoint relevante *(item 16)*
- [ ] CI, análise de dependências e proteção de segredos ativos *(item 18)*
- [ ] Avaliação externa demonstrando retenção e crescimento
- [ ] Pentest sem riscos críticos ou altos pendentes

Até lá, o honesto é apresentar como **plataforma experimental de aprendizagem adaptativa**, não como substituto da Alpha. A prioridade agora não é um algoritmo novo — é tornar invariantes as garantias já prometidas: uma tentativa, um conjunto imutável de itens, uma finalização, uma decisão de domínio, uma concessão de XP.

---

## O que apareceu no caminho

Coisas que a auditoria não listou e que o trabalho dos PRs #22–#26 revelou. Registradas aqui para não se perderem:

- **Prova impossível de passar.** Um item cuja `correctAnswer` não corresponde a nenhuma opção renderiza normalmente e reprova todo aluno, sempre — e o motor lê isso como lacuna e manda o aluno de volta a um pré-requisito que ele já domina. Agora é rejeitado na leitura (#24), mas **os itens gerados por LLM entram pelo mesmo caminho**: vale checar quantos já existem no banco.
- **Conceito atribuído pelo cliente no nivelamento** (#26). Mesma família do #20, em endpoint diferente. Sugere varrer os outros endpoints que aceitam identificador vindo do navegador — é o item 16.
- **`executeSql` liga parâmetros por ordem de aparição, não pelo número do `$N`.** Um placeholder repetido consome um argumento a menos e escreve na coluna errada sem falhar. Já mordeu duas vezes. Confirmado por uma segunda auditoria lendo `db.ts` linha a linha — **virou item formal, o 7**, com critérios de aceite específicos.
- **Confiança do domínio ainda é 1.0 para prova e 0.6 para nivelamento, fixos.** É o item 23, e continua certo adiar até haver aluno real — mas o campo já existe e já é lido, então o dia em que houver dado ele está pronto.

Da segunda auditoria, mais três achados que não viram item numerado por serem P1 (não bloqueiam aluno real sozinhos, mas valem registro para não se perderem):

- **`responseTimeMs` em `quiz/answer.ts` vem do navegador e o servidor aceita qualquer número finito.** Não altera a nota, mas alimenta diagnóstico, remediação, foco e XP — um valor forjado pode empurrar um aluno para "adivinhação" ou "atenção" incorretamente. Vale recusar negativos, definir teto plausível e registrar horário de entrega no servidor para comparar.
- **A revisão do currículo (item 6) deriva de contagens, soma de versões e `MAX(updated_at)`** — timestamp do SQLite tem precisão de segundo, então duas publicações no mesmo segundo podem produzir a mesma impressão digital. Uma revisão monotônica incrementada dentro da própria transação de publicação seria mais robusta; não é urgente porque publicação simultânea no mesmo segundo é rara hoje, mas registrar para quando a autoria tiver mais gente.
- **`CURRICULUM_REQUIRE_DATABASE` (item 5) é opt-in, desligado por padrão** (`api/_lib/curriculum.ts:432`) — esquecer de setar em produção degrada silenciosamente para os arquivos, com aviso só em log e health check. Vale exigir banco quando `NODE_ENV=production` salvo override explícito, e validar variáveis de ambiente no boot.
