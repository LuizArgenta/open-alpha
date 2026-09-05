# PRD v2 — Evidência, autoria e motivação

Continuação de [PRD-adaptive-learning-engine.md](./PRD-adaptive-learning-engine.md), que cobre as Fases 0 a 6 (motor de decisão, revisão espaçada, diagnóstico de erro, focus meter, validação de conteúdo, painel acionável).

Este documento lista o que falta para o Open Alpha ter a arquitetura de aprendizagem completa descrita no relatório do Timeback, **mantendo-se como webapp**.

---

## Restrições assumidas

1. **Webapp apenas.** Sem app desktop, sem captura de tela, OCR, webcam, microfone ou biometria. Isso descarta, de propósito, o Desktop App, o StudyFilm e a camada de *screen interpretation* do Timeback. O relatório marca essa camada como risco, e ela não é necessária para acurácia de aprendizagem.
2. **O estado acadêmico é determinístico e auditável.** IA gera e classifica; ela não é banco de verdade sobre currículo, mastery ou identidade.
3. **Nada entra sem evidência.** Toda decisão sobre um aluno precisa ser reconstruível a partir do que foi registrado.

## O que já existe (nos PRs #2–#9)

Sequenciamento por pré-requisitos, mastery gating, volta ao pré-requisito que trava, revisão espaçada com escada de Leitner, diagnóstico do tipo de erro, focus meter calibrado e contestável, validação de lição gerada, alertas acionáveis para o adulto, e 58 testes de regressão.

## O bloqueio estrutural que decide quase tudo

Duas peças da base atual impedem metade desta lista:

- **Os quizzes são gerados e descartados.** Nenhuma tabela guarda item, tentativa ou resposta; só o score agregado chega em `progress`, e o evento `quiz_answer` não diz *qual* questão foi respondida. Sem isso não há rastreabilidade, não há calibração de dificuldade e não há teste de nivelamento.
- **O currículo é carregado de arquivos JSON em tempo de import** (`export const subjects = loadSubjects()`). O sistema de arquivos da Vercel é somente leitura, então **nenhuma UI de autoria consegue existir** enquanto o currículo viver só em arquivo.

Resolver essas duas é o caminho crítico. Quase todo o resto depende de uma delas.

---

## Bloco A — Evidência e rastreabilidade

> Prioridade máxima. É o que professores e pais precisam, e é pré-requisito do nivelamento.

### A1. Persistir a evidência de avaliação
**O quê:** banco de itens e registro de tentativas e respostas.
- `assessment_items` — enunciado, alternativas, gabarito, explicação, conceito, dificuldade, origem (autorado/gerado), versão
- `assessment_attempts` — aluno, conceito, início, fim, score
- `assessment_responses` — tentativa, item, alternativa escolhida, acerto, tempo de resposta

**Por quê:** hoje é impossível responder "por que meu filho foi reprovado nesse conceito?" — a prova não existe mais. Também destrava calibração de item, nivelamento e reprodutibilidade.
**Muda:** `api/tutor/quiz.ts` passa a persistir o que gerou; `quiz/submit.ts` grava respostas item a item.
**Depende de:** nada. **Esforço:** médio.

### A2. Log de decisões do motor
**O quê:** tabela `learning_decisions` com aluno, momento, tipo (próximo conceito, remediação, diagnóstico, agendamento, nivelamento), o que foi decidido, o código do motivo e os sinais de entrada.

**Por quê:** quando a Fase 1 manda o aluno de volta para divisão, isso não fica registrado em lugar nenhum. O painel da Fase 6 afirma "já foi mandado de volta para um conceito anterior" sem ter como provar. Como o motor é determinístico, gravar a decisão é barato.
**Depende de:** nada. **Esforço:** baixo.

### A3. Linha do tempo do aluno para professor e responsável
**O quê:** visão cronológica que junta A1 e A2 — o que foi estudado, o que foi respondido, o que o sistema decidiu e por quê.
**Por quê:** é a forma concreta da rastreabilidade. Sem ela, A1 e A2 são dados que ninguém lê.
**Depende de:** A1, A2. **Esforço:** médio.

### A4. Override humano com registro
**O quê:** professor ou responsável pode liberar um conceito, marcar como dominado ou descartar um alerta — sempre com autor e justificativa gravados.
**Por quê:** o relatório coloca isso como requisito de governança ("possibilidade de override/revisão"). O adulto precisa poder discordar da máquina sem editar banco.
**Depende de:** A2. **Esforço:** baixo.

---

## Bloco B — Avaliação prévia (nivelamento)

### B1. Teste de nivelamento por matéria
**O quê:** ao entrar numa matéria, o aluno faz um diagnóstico que desce a cadeia de pré-requisitos amostrando 2–3 itens por conceito, até encontrar o piso onde ele demonstra domínio. O resultado popula `progress` com estimativas baseadas em evidência.

**Por quê:** hoje o ponto de entrada é a **série** do aluno, e os pré-requisitos abaixo dela são *assumidos* dominados sem nenhuma prova. Isso é exatamente o que o modelo existe para eliminar. A Fase 1 remedia depois de três falhas; o nivelamento resolve na entrada.
**Depende de:** A1. **Esforço:** médio-alto.

### B2. Mastery com confiança e origem
**O quê:** além do score, cada estado de domínio passa a carregar **origem** (nivelamento, quiz, override, presumido pela série) e **confiança**, que decai com o tempo.
**Por quê:** hoje "dominado porque está abaixo da série" e "dominado porque acertou 5 de 5" são indistinguíveis no banco. Tornar a suposição explícita permite ao motor tratá-la como frágil — e ao professor ver o que é chute do sistema.
**Depende de:** B1. **Esforço:** médio.

---

## Bloco C — Autoria de cursos e trilhas

> É o que o administrador pediu: criar cursos, trilhas e árvores futuras.

### C1. Currículo no banco, arquivos como semente
**O quê:** mover o currículo para tabelas (`subjects`, `concepts`, `concept_prerequisites`), com importador que carrega os JSON existentes e mantém o caminho de contribuição por PR.
**Por quê:** **sem isso não existe autoria.** O FS da Vercel é somente leitura e o currículo é lido no import do módulo.
**Depende de:** nada. **Esforço:** alto — é a mudança mais invasiva da lista, mexe em todo `_lib/curriculum.ts`. Os testes existentes protegem esse refactor.

**Decisão de arquitetura (definida ao implementar os blocos A, B e D):** a leitura do currículo **continua síncrona**. `_lib/curriculum.ts` já é a costura por onde todo o resto passa — `getConcept`, `getNextConcept`, geração de lição, quiz, nivelamento — e tornar essa interface assíncrona espalharia `await` por todos os consumidores sem ganho nenhum. O carregamento usa *top-level await* (o projeto é ESM) para popular um cache em memória na inicialização do módulo, exatamente como o carregador de arquivos se comporta hoje: uma vez por instância serverless.

Cada conceito vira **uma linha com um blob JSON** mais colunas indexadas (id, matéria, nível, pré-requisitos), em vez de normalização completa. O conteúdo é aninhado e rico, o grafo tem centenas de conceitos, e ele é carregado inteiro para a memória de qualquer forma — normalizar custaria flexibilidade de schema sem comprar nada.

Os arquivos JSON permanecem como **semente e fallback**: se o banco ainda não tem currículo (instalação nova) ou falha, o carregador cai para os arquivos. Isso evita que uma indisponibilidade do banco derrube a aplicação inteira na carga do módulo.

### C2. Papéis de administrador e professor
**O quê:** ampliar os papéis além de `student` e `parent`.
**Atenção:** `role` tem `CHECK (role IN ('student','parent'))` e SQLite não altera CHECK — exige reconstrução da tabela `users` com cópia de dados. Precisa de migração cuidadosa, não de um `ALTER`.
**Depende de:** nada. **Esforço:** médio (pela migração).

### C3. Editor de árvore de conceitos
**O quê:** UI para criar matéria, adicionar conceitos, ligar pré-requisitos e visualizar o grafo, com validação ao salvar — ciclos, pré-requisito inexistente, nível inconsistente. As regras já existem em `curriculum/validate.js` e seriam extraídas para uso compartilhado.
**Depende de:** C1, C2. **Esforço:** alto.

### C4. Rascunho, revisão e publicação
**O quê:** conceito e lição passam por `rascunho → em revisão → publicado`, e só publicado chega ao aluno.
**Por quê:** as tabelas `contributions` e `contribution_reviews` já existem, a fila de revisão já tem endpoint — mas **o status `deployed` nunca acontece**: nada leva uma contribuição aprovada para o currículo servido. O laço está pela metade.
**Depende de:** C1. **Esforço:** médio.

### C5. Geração de conteúdo para árvores novas
**O quê:** ao publicar conceitos novos, disparar geração das lições em lote, passando pela validação da Fase 5, com a fila de revisão antes de liberar.
**Por quê:** criar uma árvore de 30 conceitos à mão é inviável; criar 30 conceitos e deixar o primeiro aluno esperar 30 segundos em cada um também.
**Depende de:** C4. **Esforço:** médio.

### C6. Versionamento de conceito e lição
**O quê:** quando o conceito muda, a lição gerada para a versão anterior não pode continuar sendo servida em silêncio.
**Depende de:** C1, C4. **Esforço:** médio.

---

## Bloco D — Motivação dentro da arquitetura

### D1. XP como moeda única
**O quê:** uma política de XP que combina prova de aprendizagem e qualidade do esforço:

| Situação | XP |
|---|---|
| Mastery com foco | integral |
| Acerto total na primeira tentativa | bônus |
| Mastery com desperdício | parcial |
| Sem mastery, apesar do foco | zero |
| Acurácia abaixo de 80% | nenhum |
| Chute sistemático / gaming | penalidade |

**Por quê:** os dois ingredientes **já existem e nunca se encontram** — foco vem do focus meter (Fase 4), prova vem do mastery (Fases 1–2). Hoje o "Earn your time back" conta minutos sentado, não aprendizagem demonstrada.
**Depende de:** nada (Fases 4 e 6 bastam). **Esforço:** baixo. **Melhor relação esforço/retorno da lista.**

### D2. Meta diária honesta
**O quê:** o alvo de 120 minutos fixos vira meta de XP. Quem aprende rápido e com foco termina antes — que é a promessa do modelo, hoje não cumprida pelo código.
**Depende de:** D1. **Esforço:** baixo.

---

## Bloco E — Camada de escola

### E1. Turmas e vínculo com professor
**O quê:** modelo de turma, matrícula e professor, além do vínculo pai-filho que já existe.
**Por quê:** uma escola não é um conjunto de famílias avulsas. É o domínio *identity & roster* do relatório, sem precisar adotar o OneRoster agora.
**Depende de:** C2. **Esforço:** médio.

### E2. Painel do professor
**O quê:** os alertas da Fase 6 aplicados a uma turma inteira, ordenados por quem precisa de atenção primeiro, com acesso à linha do tempo (A3).
**Depende de:** A3, E1. **Esforço:** médio.

---

## Bloco F — Fechar o laço com avaliação externa

### F1. Importar resultado de avaliação externa
**O quê:** professor registra resultados de prova externa (simulado, prova da escola, avaliação alinhada à BNCC) por aluno e por habilidade.
**Por quê:** é a tese central do relatório — *aprendizagem é mudança durável que transfere*, e acurácia dentro do app não prova transferência. Num webapp isso é viável: uma importação manual já destrava o laço.
**Depende de:** A1. **Esforço:** médio.

### F2. Relatório de divergência
**O quê:** conceitos que o sistema dá como dominados e a avaliação externa contradiz. Alimenta recalibração de itens e de limiar.
**Por quê:** o relatório é explícito: *"falha invisível é pior que erro visível"*.
**Depende de:** F1. **Esforço:** médio.

### F3. Alinhamento a competências (BNCC)
**O quê:** campo de competência/habilidade no conceito, mapeável para BNCC.
**Por quê:** é o papel do CASE na arquitetura do Timeback, e é o que torna F1 comparável e o produto utilizável por uma escola brasileira de verdade.
**Depende de:** C1. **Esforço:** médio.

---

## Bloco G — Base técnica e conformidade

### G1. CI no GitHub Actions
`npm test` e `tsc --noEmit` em todo PR. Sem isso os 58 testes só rodam quando alguém lembra.
**Esforço:** baixo.

### G2. LGPD para dados de menores
Política de retenção, exportação e exclusão de dados, consentimento explícito do responsável, e política de privacidade real. Para uso numa escola brasileira isso não é opcional.
**Esforço:** médio, e parte não é código.

### G3. Vocabulário de eventos compatível com Caliper
Não adotar o padrão agora, mas nomear e estruturar os eventos de forma que um adaptador futuro seja mecânico.
**Esforço:** baixo se feito junto com A1/A2; caro depois.

---

## Ordem recomendada

O caminho crítico é evidência → nivelamento → autoria.

1. **D1 + D2 (XP)** — barato, alto impacto, sem dependências. Começa entregando valor enquanto o resto é construído.
2. **A1 (evidência de avaliação)** — destrava tudo no bloco de rastreabilidade e o nivelamento.
3. **A2 (log de decisões)** — barato e imediatamente útil no painel que já existe.
4. **A3 + A4** — a rastreabilidade vira algo que professor e pai realmente veem e podem contestar.
5. **B1 + B2 (nivelamento)** — elimina a série como proxy de conhecimento.
6. **C1 (currículo no banco)** — refactor grande; os testes existentes protegem.
7. **C2 → C3 → C4 → C5** — autoria de cursos e árvores, do papel até a publicação.
8. **E1 + E2** — camada de escola sobre o que já existe.
9. **F1 → F2 → F3** — fecha o laço externo.

G1 deveria vir antes de tudo, custa uma tarde.

## Fora de escopo, de propósito

App desktop, captura de tela, OCR, webcam, microfone, biometria, detecção de presença, StudyFilm, recompensa em dinheiro real, e personalização por interesse como eixo central do ensino.
