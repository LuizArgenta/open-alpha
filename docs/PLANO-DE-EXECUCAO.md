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

[#32](https://github.com/LuizArgenta/open-alpha/pull/32) trouxe o banco de itens (item 19) e o núcleo do item 10; auditado no próprio PR antes de mesclar, com o conflito em `db.ts` resolvido preservando as três migrações. [#34](https://github.com/LuizArgenta/open-alpha/pull/34) fechou o item 11 e a API de transação com callback que os itens 9 e 11 precisavam, [#35](https://github.com/LuizArgenta/open-alpha/pull/35) fechou o item 9 — de quebra, tapando uma exposição a `SQLITE_BUSY` que existia desde o PR #22 — [#36](https://github.com/LuizArgenta/open-alpha/pull/36) fechou o item 10 e [#37](https://github.com/LuizArgenta/open-alpha/pull/37) fechou o item 12 — **com isso a metade de integridade do Marco 1 (itens 1 a 12) está inteira** — e [#38](https://github.com/LuizArgenta/open-alpha/pull/38) endureceu a cadeia de build (item 18, metade que sai por PR).

**271 testes** em `main`, contra 160 quando este plano foi escrito.

**Cobertura de conteúdo autorado, medida e não estimada:** dos **141 conceitos**, apenas **9** têm `masteryCheck`. Todos os 9 têm `id` estável e ≥5 itens, então o banco de itens do #32 não regride nada — mas quer dizer que os itens 19 a 21 valem hoje para **6% do currículo**. Os outros 94% caem na geração por LLM. Nenhum algoritmo de seleção conserta isso; é trabalho de autoria, e está registrado em "Fora de PR".

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
- [x] **2. Transação única na submissão** *(fechado pelo item 9)* — PR #22. `executeTransaction` no `db.ts`; a submissão decide tudo antes de escrever e escreve uma vez, com as decisões dentro da transação. Tentativa expira em 2h, varrida na próxima prova que o aluno abre. **O que falta:** o `UPDATE` que fecha a tentativa não repete `finished_at IS NULL` dentro da transação — duas submissões concorrentes da mesma tentativa passam as duas pela checagem feita antes de abrir a transação e as duas escrevem. Fechado pelo item 9.
- [x] **3. Mesmo modelo de tentativa no nivelamento** — PR #26. Fechou um buraco não previsto: o conceito ao qual cada resposta contava vinha do cliente.
- [x] **4. Endurecer a leitura do currículo** *(fechado pelo item 10)* — PR #24. Validação por registro, importação transacional, hash de conteúdo. Achou também a prova impossível de passar: resposta que não casa com nenhuma opção. **O que falta:** isso valida o currículo lido do JSON/banco, não o item já persistido em `assessment_items` — `storeItem` reaproveita o registro antigo pelo `authoredId` sem comparar conteúdo, então editar uma questão autorada sem trocar o id deixa alunos respondendo um enunciado novo contra um gabarito antigo. Fechado pelo item 10.
- [x] **5. Fim do fallback silencioso** — PR #23. `curriculumStatus`, `GET /api/health/curriculum` respondendo 503, aviso na página de admin, e `CURRICULUM_REQUIRE_DATABASE` para recusar servir os arquivos.
- [x] **6. Invalidação do cache de currículo** — PR #25. Revisão derivada (ninguém precisa lembrar de incrementar) e refresh em segundo plano; publicar força a instância que atendeu.
- [x] **7. Corrigir o binding de parâmetros SQL ($N)** *(P)* — [PR #29](https://github.com/LuizArgenta/open-alpha/pull/29). `executeSql` e `toLibsqlStatement` (`db.ts`) agora ligam por `params[Number(number) - 1]` numa função só, e lançam erro em vez de ligar silenciosamente quando falta argumento. Varredura no repositório não achou consulta que dependesse do comportamento antigo — mas a suíte completa achou uma direta: o `UPDATE progress` em `submit.ts` tinha `$4/$5/$6` fixos no `WHERE` que só coincidiam com a posição certa quando havia `schedule`; corrigido numerando os placeholders a partir de um contador. Prova viva de por que o binding por posição era perigoso.
- [x] **8. Garantir equivalência entre banco novo e banco migrado** *(M)* — [PR #31](https://github.com/LuizArgenta/open-alpha/pull/31). `ensureAssessmentResponsesUniqueConstraint` (`db.ts`) checa `PRAGMA index_list` e, se a constraint não existe, deduplica respostas existentes (mantém a mais antiga por `attempt_id, item_id`) e cria o índice único, retroativo em qualquer instalação. Rodada a cada boot, mas barata: sai no primeiro check quando já está em dia. **Escopo:** cobre o achado específico da auditoria (`assessment_responses`); um diff de schema genérico entre banco novo e migrado, cobrindo toda tabela, fica para o item 12 (migrações versionadas), que é o lugar estrutural certo para isso.
- [x] **9. Tornar a finalização da tentativa concorrente-segura e idempotente** *(M)* — [PR #35](https://github.com/LuizArgenta/open-alpha/pull/35). Completa o item 2. Com o `withTransaction` do #34 no lugar, a tabela `assessment_attempt_finalizations` que este item previa **deixou de ser necessária**: o guard vai direto no invariante — `UPDATE ... WHERE id = $2 AND finished_at IS NULL RETURNING id` como primeira instrução da transação, e o resto só roda se ela reivindicou a tentativa. `xp_awards` ganhou `attempt_id` com índice único parcial, então "um XP por tentativa" passa a ser garantia do banco, não só do caminho de código — e um XP passa a ser rastreável até a evidência que o gerou.

  **Duas armadilhas encontradas sondando o banco real, não lendo documentação:** (a) `UPDATE ... RETURNING` no libsql reporta `rowsAffected: 0` mesmo quando altera a linha, então o guard tem de contar `rows.length` — escrito do jeito óbvio, ele acharia que sempre perdeu a corrida e nunca finalizaria nada; (b) `client.transaction('write')` **lança `SQLITE_BUSY` no próprio BEGIN** quando já há transação de escrita aberta contra SQLite local, e isso acontecia *fora* do `try`, vazando cru — exposição que existia desde o PR #22 no `executeTransaction`. Sem tratar, este item trocaria dado corrompido por 500. Resolvido com uma fila de escrita em processo (`enqueueWrite`): leituras seguem livres, só os corpos de transação enfileiram, então o entrelaçamento que o guard existe para pegar continua acontecendo. Custa nada contra Turso remoto e torna o modo local determinístico — que é o modo que o item 33 promete.

  Cinco dos sete testes novos falham contra o código anterior, verificado revertendo o `submit.ts`.
- [x] **10. Versionar itens autorados como snapshots imutáveis** *(M)* — o núcleo veio no [#32](https://github.com/LuizArgenta/open-alpha/pull/32) (`storeItem` casa por `content_hash`, então editar a questão mantendo o `authoredId` cria item novo em vez de reaproveitar o antigo) e o que sobrava fechou no [PR #36](https://github.com/LuizArgenta/open-alpha/pull/36). O ponto fraco era o hash ser uma **projeção escrita à mão**: campo novo em `ItemBankQuestion` que ninguém espelhasse em `snapshotItem` faria dois itens diferentes colidirem numa identidade só — o bug do item 4 de volta, agora sem sintoma. Como tipo não existe em tempo de execução, o guard lê o próprio fonte, na mesma convenção do `i18n-keys.test.ts`: compara os campos declarados na interface com os que entram no hash. Verificado adicionando um `hintText` só à interface — o teste quebra e a mensagem nomeia o campo. Cobre também o comportamento: cada campo, mudado isoladamente, muda o hash; ordem das chaves não muda; e opcional omitido vale o mesmo que escrito com o padrão, para não órfãos tentativas antigas à toa.
- [x] **11. Tornar `openAttempt` transacional** *(M, era P)* — [PR #34](https://github.com/LuizArgenta/open-alpha/pull/34). Traz junto o pré-requisito que faltava: `withTransaction(callback)` no `db.ts`, uma transação cujos statements seguintes podem depender do que os anteriores retornaram — o que o `executeTransaction` de lista preparada deliberadamente não faz. As duas convivem: a lista preparada continua sendo o certo quando toda escrita é conhecida de antemão. A tentativa e seus vínculos passam a ser uma unidade, e abrir tentativa com zero itens é recusado. **Escopo ajustado por causa do #32:** guardar os itens fica *fora* da transação de propósito — desde o banco de itens eles são snapshots endereçados por conteúdo, então um item deixado para trás por uma falha não é lixo, é linha válida que a próxima requisição com o mesmo conteúdo encontra e reaproveita. O estado parcial perigoso é outro: tentativa que existe com só parte dos vínculos, porque a nota divide por `COUNT(*)` sobre `assessment_attempt_items` — vínculo que não entrou encolhe o denominador e **infla a nota em silêncio**. Os dois testes novos falham contra o código anterior, verificado revertendo o `assessment.ts`.
- [x] **12. Criar migrações versionadas e parar de engolir erros** *(M)* — [PR #37](https://github.com/LuizArgenta/open-alpha/pull/37). `_schema_migrations` (id, `applied_at`), registry append-only, cada migração roda no máximo uma vez, e a primeira que falhar **para a inicialização** em vez de deixar as seguintes construírem sobre um passo que não aconteceu. As quatro migrações deliberadas viraram entradas numeradas (`002` a `005`), e o lote aditivo legado virou a `001` — que agora tolera **só** `duplicate column name`, o único erro que de fato significa "já aplicado". Antes, o `catch {}` descartava também erro de permissão, conexão, corrupção e constraint. Novo `GET /api/health/schema` responde 503 enquanto uma migração não terminou, com o erro visível só para staff, seguindo a forma do `/api/health/curriculum`.

  **Checksum foi considerado e recusado, com motivo:** este item pedia `_schema_migrations (id, checksum, data)`. Para migração escrita como string de SQL o checksum vale — pega alguém editando migração já aplicada, que é como banco novo e banco atualizado divergem em silêncio. Aqui são funções que chamam outras funções: um checksum do corpo da função perderia mudança um nível abaixo e ao mesmo tempo derrubaria o boot por um comentário reescrito. Falsa confiança e falso alarme na mesma linha. O registry é append-only em vez disso: corrigir migração aplicada significa acrescentar outra.

  **Consequência que vale saber:** as migrações deixaram de ser auto-curativas. Antes, os reparos do #31 e do #32 rodavam a cada boot e consertariam uma instância que perdesse a constraint por qualquer motivo; agora rodam uma vez e são registrados. É o que "versionada" significa, mas é uma troca real. Três arquivos de teste simulavam banco legado derrubando tabelas e chamando `initializeSchema()` de novo — passaram a usar `forgetMigration()`, porque um banco anterior à migração também não teria o registro dela. Sem isso a simulação vira "banco vandalizado pelas costas do migrador", que não é o caso que o migrador existe para resolver.
- [ ] **13. Argon2id, rate limiting e anti-enumeração** *(M)* — bcrypt com 10 rounds hoje; login e cadastro sem limite de tentativas.
- [ ] **14. Sessão: token curto, rotação, revogação, logout global** *(M)* — hoje o token vale 7 dias e não há como revogar.
- [ ] **15. Sair do localStorage para cookie HttpOnly + CSRF** *(G)* — **fazer isolado.** Toca toda chamada autenticada do frontend; um erro aqui derruba o login de todo mundo.
- [ ] **16. Varredura de IDOR/BOLA** *(M)* — feito para pai/filho e tentativas; falta progresso, sessões, interesses e coach. **Critério de aceite, porque "varrer" não é verificável:** listar todo endpoint que aceita identificador vindo do navegador (`api/progress/*`, `api/interests/*`, `api/coach/*`, `api/tutor/*`, `api/parent/*`), e para cada um ter um teste que chama com o identificador de **outro** usuário e espera 403/404. Endpoint sem esse teste conta como não varrido.
- [x] **17. CSP, HSTS, frame-ancestors, CORS explícito** *(P)* — [PR #28](https://github.com/LuizArgenta/open-alpha/pull/28). `vercel.json` passa a enviar CSP (`default-src 'self'`, sem `unsafe-inline` nem wildcard), HSTS com preload, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy` e `Permissions-Policy` em toda resposta, com teste de regressão em `tests/security-headers.test.ts`. O `Access-Control-Allow-Origin: *` citado aqui **não era o problema**: `api/curriculum/lesson.ts` e os outros seis endpoints com o mesmo header (`curriculum/graph`, `curriculum/gaps`, `contribute/lesson`, `contribute/quiz`, `quality/review`, `quality/review-queue`) são de propósito público — conteúdo do currículo e a API de contribuição para agentes, documentados como tal no próprio arquivo. Nenhum endpoint com dado privado ou autenticado usa CORS aberto hoje.
- [ ] **18. Dependabot, CodeQL, secret scanning, actions fixadas por SHA** *(P)* — **metade feita no [PR #38](https://github.com/LuizArgenta/open-alpha/pull/38), metade depende de configuração do repositório e não sai por PR.**

  **Feito:** actions fixadas por SHA (`actions/checkout` e `actions/setup-node` em `11d5960a…` e `49933ea5…`, ambos v4.4.0, resolvidos do remoto e conferidos contra a lista de tags de release — não chutados); `permissions: contents: read` no workflow, porque um job que só lê não precisa de token que escreve; `persist-credentials: false` no checkout, que senão deixa o token do job no `.git/config` ao alcance de qualquer passo seguinte, inclusive do que roda durante `npm ci`; e `.github/dependabot.yml` cobrindo github-actions mais os três manifestos npm (raiz, `frontend`, `backend` — uma entrada só na raiz deixaria os dois workspaces sem vigilância). Dependabot é a outra metade do pin: fixar por SHA sem ele apenas congela versão vulnerável no lugar.

  **Deliberadamente fora:** CodeQL e dependency review. O repositório **não aparece na busca pública do GitHub, ou seja, é privado**, e os dois exigem GitHub Advanced Security nesse caso — adicioná-los deixaria todo PR vermelho por falta de licença, não por defeito no código. Entram no dia em que o repositório virar público ou ganhar GHAS.

  **Falta, e é você quem faz (Configurações do repositório):** habilitar secret scanning com push protection; proteger `main` contra force-push e exclusão; exigir CI verde e revisão antes do merge. Nada disso é expressável em arquivo — está também em "Fora de PR". SBOM por release fica para quando houver processo de release.

## Marco 2 — Tutor local confiável

- [x] **19. Banco de itens** *(G)* — pool por habilidade em vez de 5 questões fixas, com dificuldade, distratores ligados a erros conhecidos e versão do item registrada em cada tentativa. **Destrava 20, 21 e 23.** **[PR #32](https://github.com/LuizArgenta/open-alpha/pull/32) mesclado.** Chegou fora da ordem desta lista: a sequência dizia "só então 19 em diante" e o trabalho aconteceu antes. Registrado assim em vez de reescrever a história.
- [ ] **20. Seleção de itens** *(M)* — não repetir item recente, limitar exposição, sortear por dificuldade. Depende do 19. Desenho detalhado em [Desenho do item 20](./DESENHO-ITEM-20-selecao-de-itens.md). **Alerta de precedência:** o pool mínimo hoje é 5 e o sorteio pede 5 — com pool de exatamente 5 não existe escolha nenhuma, e as três restrições ficam insatisfazíveis por construção. Item 20 sem autoria de itens é código sem efeito.
- [ ] **21. Nivelamento adaptativo** *(G)* — próxima questão escolhida pelas anteriores, regra estatística de parada, intervalo de confiança, retomada em outro dia. Depende do 19.
- [ ] **22. Geração de lições em lote para árvores novas** *(M)* — item C5 do PRD v2, não entregue. ⚠️ **Bloqueado, não apenas "não verificável":** sem credenciais ATXP não dá para implementar nem testar. Ou alguém consegue a credencial, ou o item sai da fila e volta quando houver — deixá-lo listado como se fosse executável distorce todo cálculo de quanto falta.
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
   3. **#32 sai de draft** — mesclado. Fechou o item 19 e a maior parte do 10. O conflito em `db.ts` foi resolvido preservando as três migrações. ✅
   4. **API de transação com callback** — `withTransaction` no `db.ts`. ✅ PR #34, junto do item 11, que é seu primeiro consumidor real.
   5. **11** — `openAttempt` transacional. ✅ PR #34.
   6. **9** — finalização da tentativa concorrente-segura e idempotente. ✅ PR #35.
   7. **10** — teste que impede o hash de sair de sincronia com a interface do item. ✅ PR #36.
   8. **12** — migrações versionadas, consolidando as quatro que existiam. ✅ PR #37. **Fecha a metade de integridade do Marco 1.**
3. **Depois, segurança de custo baixo e risco alto:** 17 (✅ PR #28) → 18 (parcial, PR #38 — o resto é configuração do repositório) → 16 → 13.
4. **Sessão:** 14, depois **isolado** o 15 (cookie HttpOnly + CSRF), por tocar toda chamada autenticada.
5. **Antes do piloto local, não depois:** 33 (distribuição local reproduzível) e 31 (backup e restauração testados) — instalar isso depois que já há aluno usando o sistema é tarde demais.
6. **LGPD (25) não espera** — corre em paralelo às entregas técnicas acima, dividida em pedaços pequenos; a revisão jurídica em si segue fora de PR.
7. **Barato e fora de ordem, mas com o maior retorno pedagógico por linha:** ligar `distractor_error_code` ao diagnóstico (ver "O que apareceu no caminho"). Depende só do #32, não dos itens 9 a 12.
8. **Só então** 20, 21, 23, 24 (seleção e algoritmos adaptativos) — e o 20 só rende depois de haver pool de itens de verdade, o que é autoria, não código.

## Definição de pronto

Chamar isto de substituto local acadêmico exige, da auditoria original e da complementar:

- [x] Toda nota calculada no servidor *(PR #20)*
- [x] Todo domínio reconstruível a partir das evidências *(PRs #20, #22, #26 guardam item, resposta e decisão; #32 e #36 tornaram o item respondido um snapshot imutável)*
- [x] Toda tentativa vinculada a aluno, finalidade e snapshot imutável dos itens *(item 10, PRs #32 e #36)*
- [x] Submissões simultâneas produzem exatamente um resultado *(item 9, PR #35)*
- [x] Banco novo e banco migrado têm constraints equivalentes para `assessment_responses` *(item 8, PR #31; o item 12 deu o registry, mas um diff genérico de schema entre banco novo e migrado segue não implementado)*
- [x] Falha intermediária em qualquer escrita composta provoca rollback integral *(itens 11 e 12)*
- [x] Migração inesperadamente defeituosa interrompe a inicialização em vez de seguir silenciosa *(item 12, PR #37)*
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

De uma terceira leitura, esta pedagógica em vez de técnica, feita durante a auditoria do #32:

- **A evidência é gravada, mas quase nada dela é lida.** O #32 grava `difficulty_tag`, `skill_tag`, `reasoning_type`, `distractor_error_code` e `pedagogical_rationale`. Varredura em `api/`: toda ocorrência desses campos é declaração de tipo, validação de entrada, definição de coluna ou `INSERT`. **Nenhum `SELECT` leva qualquer um deles a uma decisão.** O que o motor realmente consome em `diagnoseAttempt` é `{ correct, responseTimeMs, at }` — ritmo e contagem, não *o quê* foi entendido errado. Consequência concreta: um aluno que erra 3 de 5 por **uma** confusão consistente e outro que erra 3 de 5 por **três** confusões distintas produzem o mesmo diagnóstico e a mesma remediação. Isso não é crítica ao #32 — não dá para adaptar sobre dado que não foi guardado, e guardar primeiro é a ordem certa. É o registro de que a camada hoje é **potencial de adaptação, não adaptação**, e de que o rótulo "motor adaptativo" descreve a intenção do schema, não o comportamento do sistema.
- **O menor passo que muda isso:** fazer `loadAttemptAnswers` trazer o `distractor_error_code` do item junto da resposta, e o `diagnoseAttempt` distinguir "erros concentrados numa única confusão" de "erros espalhados". Depende só do #32, não dos itens 9 a 12, e é a diferença entre ter dado e usar dado.
- **Sinal fino já existente e ignorado:** `rapidAnswerThresholdMs` usa a dificuldade do **conceito**, enquanto o banco de itens do #32 passa a ter dificuldade **por item**. O limiar de "respondeu rápido demais" podia ser por item e é por conceito.
- **Gate silencioso no `quiz.ts` do #32:** a condição virou `masteryItemCount >= 5 && hasStableIds`. Uma questão autorada sem `id` faz o conceito **parar de usar conteúdo autorado e cair na geração por LLM**, sem erro nem log. Hoje os 9 conceitos com `masteryCheck` passam, então não regride — mas é armadilha para o primeiro contribuidor que esquecer um `id`.
