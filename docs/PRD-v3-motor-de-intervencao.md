# PRD v3 — Motor de intervenção

*6 de setembro de 2026. Recalibração arquitetural. Não substitui as PRDs v1 e v2 — reinterpreta os mecanismos delas dentro de um laço maior.*

---

## 1. Tese

**O Open Alpha é um motor de inteligência e intervenção sobre a aprendizagem.** Observa evidências, estima o estado do aluno, escolhe a menor intervenção útil, mede o resultado e atualiza o estado.

Não precisa ser uma LXP. Pode oferecer lições, mas isso é *uma forma* de intervenção, não o produto.

### O conteúdo não é nosso — em dois sentidos

**Não é proprietário.** O grafo curricular é aberto e colaborativo, e cresce ao longo do tempo: mais matérias, mais domínios, povoados por professores e — mais adiante — por IA em escala. É a tese da "Wikipédia do aprendizado" do `ROADMAP.md`, e ela **não conflita** com este documento: um grafo aberto é o oposto de um repositório proprietário.

**E não precisa ser só nosso.** O motor tem que funcionar igualmente bem sobre o livro da escola, o LMS dela ou as provas dela. Por isso `Intervention.source` admite `open_alpha`, `teacher`, `school`, `external` e `generated` como iguais — nenhum deles é o caminho privilegiado.

A consequência comercial: **a escola não precisa trocar o que já usa.**

**Prioridade declarada:** povoar o grafo em massa não é o foco agora. O que é foco agora é não fechar a porta — e a porta está fechada hoje, pela seção 5.4.

## 2. O laço

```
Evidência → Estado de conhecimento → Decisão → Intervenção → Resultado
     ↑                                                          │
     └──────────────────────────────────────────────────────────┘
```

**Princípio de economia de intervenção:** o objetivo não é maximizar tempo no aplicativo. É resolver a lacuna com a menor intervenção necessária e devolver o aluno ao fluxo normal.

## 3. Non-goals

Escrito porque nunca esteve escrito, e a ausência já custou caro — foi assim que dois backends coexistiram por meses.

O Open Alpha **não** será:

1. **SIS, ERP ou secretaria.** Notas oficiais, matrícula legal, cobrança, RH — integra, não substitui.
2. **LMS/LXP completo.** Não hospeda o curso da escola.
3. **Repositório obrigatório de conteúdo.** Precisa funcionar sobre material que não é nosso.
4. **Dependente de um LLM específico.** Nenhuma regra pedagógica cita provedor ou modelo.
5. **Event sourcing.** O stream de eventos é evidência e telemetria; as tabelas operacionais continuam sendo a fonte de escrita.
6. **Offline distribuído — ainda.** Não implementar sync. Só não fechar a porta: ids globais, idempotência, eventos versionados.

## 4. Teste de aceitação da arquitetura

> Se amanhã uma escola disser *"não quero seu conteúdo, quero meu livro, meu LMS e meu endpoint de IA"*, o Open Alpha ainda consegue diagnosticar, decidir, recomendar uma intervenção e medir o resultado?

**Hoje: não.** Quatro razões, todas mensuradas na seção 5.

## 5. Quatro pré-condições que a arquitetura-alvo assume e que não existem

Esta é a parte que separa este documento do memorando que o originou. As abstrações propostas são boas; elas se apoiam em coisas que não estão lá.

**As quatro têm a mesma forma**, e vale nomear o padrão porque ele já apareceu quatro vezes numa auditoria só: *as duas pontas foram construídas e testadas, e o meio não existe.* Cada metade funciona; a ligação entre elas não; e nada percebe, porque nenhum teste percorre o caminho inteiro. O quinto caso foi encontrado e corrigido esta semana — o dashboard chamava `/api/progress/gamification` e nada respondia.

### 5.1 Os metadados pedagógicos não chegam a nenhuma decisão

`difficulty_tag`, `skill_tag`, `reasoning_type`, `distractor_error_code` e `pedagogical_rationale` são escritos, validados e indexados. **Nenhum `SELECT` no repositório lê qualquer um deles.**

`diagnoseAttempt` recebe exatamente `{correct, responseTimeMs, at}` — acertou, quanto demorou, quando. Um aluno com três erros da mesma concepção equivocada e outro com três erros distintos recebem diagnóstico idêntico.

**Consequência direta:** a fila de intervenções do professor, apontada como maior diferencial, é ilustrada com *"3 erros com o mesmo misconception, confiança: alta"*. Isso é impossível de calcular hoje. Não é "ampliar o uso dos metadados" — é começar a usá-los.

### 5.2 O servidor não escreve no stream de eventos

`learning_events` é escrita por **um único endpoint**, `api/progress/events.ts`, que o **navegador** chama.

Nada do que o servidor sabe entra ali: tentativa aberta, resposta corrigida, decisão tomada, XP concedido, tentativa expirada. Foi assim que a sequência do dashboard mostrou zero para um aluno que tinha acabado de fazer uma prova.

**Consequência:** transformar `learning_events` em contrato canônico hoje canoniza um stream com buracos, dependente de um navegador cooperar. O servidor precisa ser o escritor **antes** de a tabela virar contrato.

### 5.3 O repertório de intervenções tem uma entrada

| Matéria | Conceitos | Com `masteryCheck` |
|---|---|---|
| math | 17 | 6 |
| algebra1 | 35 | 3 |
| **outras 7 matérias** | **89** | **0** |
| **total** | **141** | **9 (6%)** |

Uma tabela `interventions` com `type: worked_example \| micro_lesson \| practice \| retrieval \| diagnostic_probe` descreve escolhas que, para 94% do currículo, não existem — resta pedir geração a um LLM.

É o mesmo erro do item 20: sortear 5 itens de um pool de exatamente 5.

A resposta para isso **não é autoria manual de 132 conceitos.** É o pipeline colaborativo — professores agora, IA em escala depois. Que existe. E que está quebrado no último metro, abaixo.

### 5.4 A contribuição aprovada nunca chega ao aluno

O pipeline colaborativo existe e é real: `api/contribute/lesson.ts`, `api/contribute/quiz.ts`, revisão por pares em `api/quality/review.ts`, reputação de contribuidor, e um estado `'deployed'` no schema.

**Nada escreve `'deployed'`.** Ele só é lido, como guarda. E nenhum caminho de código pega uma contribuição aprovada e a insere em `curriculum_concepts` ou `assessment_items`.

Um professor contribui uma prova. Dois revisores aprovam. Ela fica em `status='approved'` para sempre.

**Consequência:** a tese do grafo aberto e colaborativo é hoje aspiracional, não porque falte gente disposta, mas porque o último passo não existe. Fechar esse metro é barato — e é o que separa "queremos conteúdo colaborativo" de "temos conteúdo colaborativo".

## 6. Modelo de domínio

### 6.1 Intervention (nova, primeira classe)

```
interventions
  id, type, concept_id, source, content_ref, estimated_minutes, version, status

intervention_runs
  id, intervention_id, student_id, decision_id,
  started_at, completed_at, outcome, evidence_summary
```

`type`: `explanation`, `worked_example`, `micro_lesson`, `practice`, `retrieval`, `diagnostic_probe`, `ai_tutoring`, `teacher_intervention`, `external_resource`.

**Guardrail:** Intervention não pode virar "uma nova tabela de lesson". Se ela não representar ação humana, recurso externo e ação de IA com igual naturalidade, o desenho falhou.

### 6.2 Contrato de decisão

O motor deixa de responder `nextConcept` e passa a responder uma ação:

```json
{ "nextAction": { "type": "micro_practice",
                  "reason": "fragile_prerequisite",
                  "conceptId": "fractions-equivalence",
                  "interventionId": "...",
                  "policyVersion": 1 } }
```

`nextConcept` permanece internamente por compatibilidade.

### 6.3 Preservado sem alteração

Tentativas, respostas, snapshots imutáveis de item, `learning_decisions`, `progress`, revisão espaçada, grafo curricular, `staff_roles`, migrações versionadas, backup/restore, teto de LLM. **A recalibração não justifica reconstrução.**

## 7. Camada de IA

**Regra:** o motor pedagógico nunca pede "GPT" ou "Claude". Pede uma *capacidade*.

```
capacidade (tutor | explain | hint | generate_item | evaluate | classify)
        ↓
resolvedor de política (aluno > turma > organização > global)
        ↓
adaptador de provedor
```

**Estado atual:** `LLM_BASE_URL` é constante fixa apontando para a ATXP. Torná-la configurável é mudança de cinco linhas e é o que faz o teste da seção 4 passar no escopo do deploy. Política por escopo é trabalho de verdade e só paga quando houver escolas.

**Tensão a decidir, não a descobrir:** a telemetria proposta registra invocação por aluno. O `recordUsage` atual **deliberadamente não guarda id de usuário**, para que o teto de gasto exista sem criar um log de quem perguntou o quê e quando — e `/data` afirma isso ao usuário. Se virar auditável por aluno, o aviso muda junto.

## 8. Avaliação em três escalas

```
CONTÍNUA (respostas + mastery + revisão)
    → BENCHMARK (itens independentes, periódico)
        → EXTERNA (prova da escola, simulado)
```

O ganho é epistemológico: **o sistema deixa de avaliar apenas com instrumentos que ele mesmo ensinou.** Um relatório de divergência entre mastery interno e desempenho independente é a única forma de o motor estar errado em público.

Barato de começar e alto valor — por isso sobe na fila.

## 9. Camada escolar

`Organization → (Campus) → AcademicTerm → Class → {Teacher assignments, Enrollments}`

"Organization" e não "school", para atender colégio, rede, secretaria ou curso independente.

**Não antes do piloto.** Adicionar `organization_id` significa reauditar o escopo de cada endpoint — a varredura de IDOR foi feita contra `student_id` e vínculo de responsável. É custo sem pagador enquanto não houver organização real.

---

## 10. Fila de PRs

Princípio: PRs pequenos, cada um com uma mudança de contrato testável. Não misturar tenancy, IA multi-provider e intervenção num refactor só.

### Onda 0 — tornar utilizável a evidência que já existe

*Nada novo. Só ligar o que está desconectado. É a onda de maior retorno por linha escrita.*

| # | PR | Critério de aceite |
|---|---|---|
| **0.1** | **Metadados pedagógicos no diagnóstico** | `loadAttemptAnswers` carrega `distractor_error_code`, `difficulty_tag` e `skill_tag`; `diagnoseAttempt` distingue *três erros pela mesma causa* de *três erros distintos*. Teste que falha se os dois casos derem o mesmo diagnóstico. |
| **0.2** | **Servidor como escritor de eventos** | Abrir tentativa, corrigir resposta, finalizar, decidir e conceder XP emitem evento. Teste: fazer uma prova sem o navegador reportar nada produz stream completo. |
| **0.3** | **Endpoint de modelo configurável** | `LLM_BASE_URL` vem do ambiente, com a ATXP como padrão. Sobe contra endpoint local compatível. |
| **0.4** | **Contribuição aprovada chega ao aluno** | Uma contribuição `approved` vira conceito ou item publicado e passa a `'deployed'`. Teste: professor contribui → dois revisores aprovam → um aluno senta a prova. Hoje esse teste é impossível de escrever. |

### Onda 1 — a mudança de contrato

| # | PR | Critério de aceite |
|---|---|---|
| 1.1 | ADR de vocabulário e non-goals | Este documento no repositório. Sem mudança de runtime. |
| 1.2 | Envelope canônico de evento v1 | `schema_version`, ids estáveis, idempotência. Eventos atuais compatíveis por adaptador. |
| 1.3 | `Intervention` + `InterventionRun` mínimas | Fluxo atual encapsulado como intervenção. Nada muda para o aluno. |
| 1.4 | Decisão retorna `nextAction` | Motor responde ação; `nextConcept` interno por compatibilidade. |
| 1.5 | Resultados de intervenção | `start`/`complete`/`outcome` alimentam stream e linha do tempo. |

### Onda 2 — medir com honestidade

| # | PR | Critério de aceite |
|---|---|---|
| 2.1 | Avaliação de benchmark | Itens independentes do que ensinou; janela e resultados versionados. |
| 2.2 | Importação de avaliação externa | Import por conceito + **relatório de divergência** contra o mastery interno. |

### Onda 3 — o multiplicador humano

| # | PR | Critério de aceite |
|---|---|---|
| 3.1 | Fila de intervenções do professor | Priorizada, com evidência, discordância e outcome. Depende de **0.1**. |
| 3.2 | Métrica de eficiência de intervenção | Δ mastery por minuto de intervenção, e retenção em 14 dias. |

*Cabe em `staff_roles` — não exige a camada escolar.*

### Onda 4 — escola (só quando houver uma)

| # | PR |
|---|---|
| 4.1 | Organization e escopo de dados |
| 4.2 | Termos, turmas, matrículas |
| 4.3 | Contrato de gateway de integração |
| 4.4 | Adaptador CSV de roster |
| 4.5 | Política de IA por capacidade e escopo |
| 4.6 | BYOK e endpoints institucionais |

### Fora da fila, e caminho crítico

- **Povoar o grafo em massa.** 9 de 141 conceitos. **Declaradamente não é o foco agora** — mas o item 0.4 é, porque é a diferença entre uma porta fechada e uma porta aberta que ninguém atravessou ainda. Professores primeiro, IA em escala depois.
- **LGPD operacional** (retenção, exportação, exclusão). O aviso existe; as três entregas não. **Bloqueia uso por menores**, não o piloto com adultos.
- **Item 13b** (Argon2id), **item 14** (sessões revogáveis). Autenticação, valem por si.
- `react-router` major.

### O que muda em relação ao memorando original

| | Memorando | Aqui | Por quê |
|---|---|---|---|
| Metadados no diagnóstico | ausente | **0.1, primeiro** | Pré-requisito não declarado do diferencial dele |
| Último metro da contribuição | ausente | **0.4** | Sem ele o grafo colaborativo é aspiracional |
| Servidor escrevendo eventos | ausente | **0.2, antes do contrato** | Canonizar um stream com buracos os torna permanentes |
| Abstração de IA | onda 1 completa | 0.3 barato agora, política na onda 4 | Política por escopo não paga sem escolas |
| Avaliação externa | onda 2, depois de tenancy | **onda 2, antes** | Barata e é o que torna o motor falsificável |
| Fila do professor | depois da camada escolar | **onda 3, antes** | `staff_roles` já basta para um piloto |
| Organization | onda 2 | **onda 4** | Reauditoria de escopo sem pagador |

---

## 11. Checklist de revisão

- [ ] A tese não chama o Open Alpha de LXP obrigatória
- [ ] O laço evidência → estado → decisão → intervenção → resultado é a espinha
- [ ] Lição, prova, tutor e microlearning são *tipos de intervenção*
- [ ] A intervenção humana do professor é primeira classe e tem outcome
- [ ] Dados operacionais e stream de eventos são distintos
- [ ] Organization/Class/Enrollment existem sem virar SIS
- [ ] O motor integra conteúdo externo em vez de exigir o próprio
- [ ] Capacidade de IA está separada do adaptador de provedor
- [ ] Cada invocação é auditável sem registrar o que não precisa
- [ ] Benchmarks podem contradizer o mastery interno
- [ ] Ids e versionamento deixam a porta do offline aberta
- [ ] Os PRs são pequenos e reversíveis
