# Plano de execução

Quadro de acompanhamento do que falta para o Open Alpha ser usável de verdade por uma escola. Deriva da auditoria de 5 de setembro de 2026 cruzada com o estado real do código.

**Como manter:** marque a caixa quando o PR for **mergeado**, não quando for aberto, e anote o número do PR ao lado. Se um item se revelar desnecessário ou mudar de forma, edite a linha e diga por quê — um item riscado sem explicação vira dúvida daqui a três meses.

Documentos relacionados: [PRD v1 — motor adaptativo](./PRD-adaptive-learning-engine.md) · [PRD v2 — evidência, autoria e motivação](./PRD-plataforma-de-aprendizagem.md)

---

## Onde estamos

*Atualizado em 5 de setembro de 2026.*

Mergeado em `main` (PRs #1 a #19): motor de decisão com volta ao pré-requisito, revisão espaçada, diagnóstico do tipo de erro, medidor de foco contestável, validação de lição gerada, alertas ao responsável, XP ligado a prova de aprendizagem, evidência de avaliação, log de decisões, linha do tempo, override humano, nivelamento, currículo no banco, autoria de matérias e árvores, pt-BR como padrão e CI.

Mergeado depois disso, os **seis primeiros itens do Marco 1**: [#20](https://github.com/LuizArgenta/open-alpha/pull/20) correção da prova no servidor, [#22](https://github.com/LuizArgenta/open-alpha/pull/22) transação única na submissão e expiração de tentativa, [#23](https://github.com/LuizArgenta/open-alpha/pull/23) fim do fallback silencioso, [#24](https://github.com/LuizArgenta/open-alpha/pull/24) leitura de currículo endurecida, [#25](https://github.com/LuizArgenta/open-alpha/pull/25) invalidação do cache de currículo, [#26](https://github.com/LuizArgenta/open-alpha/pull/26) nivelamento no modelo de tentativa.

**204 testes**, contra 160 quando este plano foi escrito.

**O que isso ainda não é:** uma plataforma segura para uso real por menores. **Toda a metade de segurança do Marco 1 (itens 7 a 12) segue aberta** — senha, sessão, IDOR, cabeçalhos, varredura de dependências. Nenhum aluno real antes disso.

---

## Marco 1 — Integridade e segurança

Nada aqui é opcional antes de colocar um aluno real no sistema.

- [x] **1. Corrigir a prova no servidor** — PR #20. A nota era declarada pelo navegador e o gabarito era enviado para a página.
- [x] **2. Transação única na submissão** — PR #22. `executeTransaction` no `db.ts`; a submissão decide tudo antes de escrever e escreve uma vez, com as decisões dentro da transação. Tentativa expira em 2h, varrida na próxima prova que o aluno abre.
- [x] **3. Mesmo modelo de tentativa no nivelamento** — PR #26. Fechou um buraco não previsto: o conceito ao qual cada resposta contava vinha do cliente.
- [x] **4. Endurecer a leitura do currículo** — PR #24. Validação por registro, importação transacional, hash de conteúdo. Achou também a prova impossível de passar: resposta que não casa com nenhuma opção.
- [x] **5. Fim do fallback silencioso** — PR #23. `curriculumStatus`, `GET /api/health/curriculum` respondendo 503, aviso na página de admin, e `CURRICULUM_REQUIRE_DATABASE` para recusar servir os arquivos.
- [x] **6. Invalidação do cache de currículo** — PR #25. Revisão derivada (ninguém precisa lembrar de incrementar) e refresh em segundo plano; publicar força a instância que atendeu.
- [ ] **7. Argon2id, rate limiting e anti-enumeração** *(M)* — bcrypt com 10 rounds hoje; login e cadastro sem limite de tentativas.
- [ ] **8. Sessão: token curto, rotação, revogação, logout global** *(M)* — hoje o token vale 7 dias e não há como revogar.
- [ ] **9. Sair do localStorage para cookie HttpOnly + CSRF** *(G)* — **fazer isolado.** Toca toda chamada autenticada do frontend; um erro aqui derruba o login de todo mundo.
- [ ] **10. Varredura de IDOR/BOLA** *(M)* — feito para pai/filho e tentativas; falta progresso, sessões, interesses e coach.
- [ ] **11. CSP, HSTS, frame-ancestors, CORS explícito** *(P)* — `api/curriculum/lesson.ts` está com `Access-Control-Allow-Origin: *`.
- [ ] **12. Dependabot, CodeQL, secret scanning, actions fixadas por SHA** *(P)* — metade é configuração de repositório.

## Marco 2 — Tutor local confiável

- [ ] **13. Banco de itens** *(G)* — pool por habilidade em vez de 5 questões fixas, com dificuldade, distratores ligados a erros conhecidos e versão do item registrada em cada tentativa. **Destrava 14, 15 e 17.**
- [ ] **14. Seleção de itens** *(M)* — não repetir item recente, limitar exposição, sortear por dificuldade. Depende do 13.
- [ ] **15. Nivelamento adaptativo** *(G)* — próxima questão escolhida pelas anteriores, regra estatística de parada, intervalo de confiança, retomada em outro dia. Depende do 13.
- [ ] **16. Geração de lições em lote para árvores novas** *(M)* — item C5 do PRD v2, não entregue. ⚠️ Não verificável sem credenciais ATXP.
- [ ] **17. Modelo probabilístico de domínio** *(G)* — BKT ou Elo educacional, com incerteza e decaimento. ⚠️ **Adiar até haver dados reais:** calibrar sem alunos é ajustar parâmetros no vácuo.
- [ ] **18. Planejador diário de atividades** *(G)* — fila misturando novidade, revisão e remediação. Só vale a pena depois do 17.

## Marco 3 — Operação com vários alunos

- [ ] **19. LGPD e proteção de menores** *(G)* — retenção por categoria, exportação, exclusão, aviso de privacidade em linguagem infantil e adulta, RIPD. **Não pode ser posterior num produto para menores.**
- [ ] **20. Log de auditoria append-only** *(M)* — logins, mudanças de papel, publicações e acessos administrativos a dados infantis.
- [ ] **21. Console de Guide** *(G)* — fila de intervenções priorizadas, histórico, notas privadas, acordos com o aluno, separação entre observação e inferência algorítmica.
- [ ] **22. Turmas, grupos e matrículas** *(M)* — uma escola não é um conjunto de famílias avulsas.
- [ ] **23. Painel do responsável completo** *(M)* — metas, limites de uso, exportação, controle de compartilhamento.
- [ ] **24. Telemetria e observabilidade** *(M)* — schema único de eventos, painel de saúde, alerta de backup vencido.
- [ ] **25. Backup e restauração testados** *(M)* — inclui teste de recuperação, não só de geração.

## Marco 4 — Plataforma equivalente

- [ ] **26. API versionada, OpenAPI, erros padronizados** *(M)* — o VISION.md promete "API-first" desde o início.
- [ ] **27. Distribuição local** *(G)* — Docker reproduzível, modo offline, LLM local por API compatível, chave de bloqueio de tráfego externo.
- [ ] **28. Padrões 1EdTech** *(G)* — OneRoster, CASE, QTI, Caliper.
- [ ] **29. Aplicativos por matéria** *(XG)* — editor matemático com rascunho e passos, leitor com fluência, editor de texto com rubricas, simulações. **É aqui que mora a diferença real para a Alpha, e cada matéria é praticamente um produto.**

---

## Fora de PR

Precisam de alguém que não é o time de engenharia:

- **Mapear os ~141 conceitos para a BNCC** — trabalho pedagógico, precisa de professor.
- **Revisão jurídica** da LGPD e da Lei 15.211/2025 — precisa de advogado.
- **Pentest** antes de operar com menores, e **validação educacional independente** — precisam de terceiros.
- **Branch protection e revisão obrigatória** — configuração do repositório.

---

## Sequência recomendada

1. ~~**Agora:** 2 → 5 → 4 → 6 → 3.~~ **Feito** (PRs #22 a #26). Nenhum caminho conhecido deixa hoje estado inconsistente numa submissão, e nenhuma instância serve currículo errado sem dizer.
2. **Agora:** 11 → 12 → 7 → 10. Segurança de custo baixo e risco alto.
3. **Antes de qualquer algoritmo novo:** 13 e 19. Sem mais itens, nivelamento e modelo probabilístico ficam limitados pelo dado, não pelo algoritmo — e LGPD não espera.
4. O 9 em separado, por tocar toda chamada autenticada.

## Definição de pronto

Chamar isto de substituto local acadêmico exige, da auditoria:

- [x] Toda nota calculada no servidor *(PR #20)*
- [x] Todo domínio reconstruível a partir das evidências *(PRs #20, #22, #26 — prova e nivelamento guardam item, resposta e decisão; falta só o banco de itens do #13 para reconstruir também **qual** item)*
- [ ] Currículo-alvo completo e revisado
- [ ] Atividades escolhidas por domínio e incerteza
- [ ] Funciona sem dependência obrigatória de nuvem
- [ ] Responsáveis podem supervisionar, contestar e excluir dados
- [ ] Backup e restauração testados
- [ ] Auditoria e resposta a incidentes
- [ ] Avaliação externa demonstrando retenção e crescimento
- [ ] Pentest sem riscos críticos ou altos pendentes

Até lá, o honesto é apresentar como **plataforma experimental de aprendizagem adaptativa**, não como substituto da Alpha.

---

## O que apareceu no caminho

Coisas que a auditoria não listou e que o trabalho dos PRs #22–#26 revelou. Registradas aqui para não se perderem:

- **Prova impossível de passar.** Um item cuja `correctAnswer` não corresponde a nenhuma opção renderiza normalmente e reprova todo aluno, sempre — e o motor lê isso como lacuna e manda o aluno de volta a um pré-requisito que ele já domina. Agora é rejeitado na leitura (#24), mas **os itens gerados por LLM entram pelo mesmo caminho**: vale checar quantos já existem no banco.
- **Conceito atribuído pelo cliente no nivelamento** (#26). Mesma família do #20, em endpoint diferente. Sugere varrer os outros endpoints que aceitam identificador vindo do navegador — é o item 10.
- **`executeSql` liga parâmetros por ordem de aparição, não pelo número do `$N`.** Um placeholder repetido consome um argumento a menos e escreve na coluna errada sem falhar. Já mordeu duas vezes. **Merece um PR próprio**, com testes, antes de crescer mais código em cima.
- **Confiança do domínio ainda é 1.0 para prova e 0.6 para nivelamento, fixos.** É o item 17, e continua certo adiar até haver aluno real — mas o campo já existe e já é lido, então o dia em que houver dado ele está pronto.
