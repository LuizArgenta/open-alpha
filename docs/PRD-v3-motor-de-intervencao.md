# PRD v3 — Motor de intervenção

*6 de setembro de 2026. Recalibração arquitetural.*

**Relação com os outros documentos:**

- **[PRD v1 — motor adaptativo](./PRD-adaptive-learning-engine.md)** permanece como está: é a **constituição do motor pedagógico**, e acerta em quatro decisões que este documento não revisa — motor determinístico antes do LLM, retenção como parte do domínio, diagnóstico de erro, e intervenção humana orientada por sinal. Explica de onde o projeto veio.
- **Os três documentos permanecem separados**, por decisão — fundir a v2 aqui perderia o registro de como o produto foi entendido em cada fase, e a evolução é parte do que eles documentam.
- **[PRD v2 — plataforma](./PRD-plataforma-de-aprendizagem.md)** tem duas metades. O **backlog de funcionalidades** continua válido e é referenciado pelo plano de execução. O **enquadramento de produto** — currículo → conceito → lição → prova → mastery → próximo conceito — é **substituído por este documento**. Não foi reescrito para preservar o registro; é aqui que se lê o que o produto é.

Este documento não substitui mecanismos. Reinterpreta os que existem dentro de um laço maior.

---

## 1. Tese

> **Open Alpha is an open adaptive learning engine that uses evidence to understand what a learner knows, choose the most effective next intervention, and verify whether it worked.**

Observa evidências, estima o estado do aluno, escolhe a menor intervenção útil, mede o resultado e atualiza o estado.

A definição anterior — *"plataforma de aprendizagem com tutor de IA"* — não está errada, está **pequena demais**. Ela descreve uma das saídas possíveis do motor como se fosse o motor.

Não precisa ser uma LXP. Pode oferecer lições, mas isso é *uma forma* de intervenção, não o produto.

### O conteúdo não é nosso — em dois sentidos

**Não é proprietário.** O grafo curricular é aberto e colaborativo, e cresce ao longo do tempo: mais matérias, mais domínios, povoados por professores e — mais adiante — por IA em escala. É a tese da "Wikipédia do aprendizado" do `ROADMAP.md`, e ela **não conflita** com este documento: um grafo aberto é o oposto de um repositório proprietário.

**E não precisa ser só nosso.** O motor tem que funcionar igualmente bem sobre quatro origens, e `Intervention.source` as trata como iguais — nenhuma é o caminho privilegiado:

| Origem | Exemplo |
|---|---|
| `external` | **Wikipedia, Wikidata, Grokipedia, OpenStax, padrões curriculares abertos** |
| `teacher` | Contribuição revisada por pares |
| `school` | O livro, o LMS e as provas de quem nos usa |
| `generated` | Modelo — preferencialmente **adaptando** as três acima, não inventando do zero |

**Corpora abertos são a via mais rápida para escala, e não são a mesma coisa que autoria.** Aproveitá-los é decisão de arquitetura, não de conteúdo: exige procedência, que hoje não existe (seção 5.5).

A consequência comercial: **a escola não precisa trocar o que já usa.**

**Prioridade declarada:** povoar o grafo em massa não é o foco agora. O que é foco agora é não fechar a porta — e a porta está fechada hoje, pela seção 5.4.

## 2. O laço

```
Evidência → Estado de conhecimento → Decisão → Intervenção → Resultado
     ↑                                                          │
     └──────────────────────────────────────────────────────────┘
```

Dois princípios governam o laço, e os dois são restrições de desenho, não features.

**Economia de intervenção.** O objetivo não é maximizar tempo no aplicativo. É resolver a lacuna com a menor intervenção necessária e devolver o aluno ao fluxo normal.

**Validação externa.** *O sistema precisa medir continuamente se suas estimativas internas predizem aprendizagem fora dele.*

Sem isso, o laço se fecha sobre si mesmo:

```
Open Alpha ensina  →  Open Alpha avalia  →  Open Alpha conclui que o Open Alpha funciona
```

Um motor que só se mede com instrumentos que ele mesmo ensinou não tem como estar errado — e "não tem como estar errado" não é elogio, é a definição de não ser científico. A avaliação externa (seção 8) é o que dá ao sistema a possibilidade de ser desmentido, e por isso é princípio, não item de backlog.

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

**Hoje: não.** Cinco razões, todas mensuradas na seção 5.

## 5. Cinco pré-condições que a arquitetura-alvo assume e que não existem

Esta é a parte que separa este documento do memorando que o originou. As abstrações propostas são boas; elas se apoiam em coisas que não estão lá.

**As quatro primeiras têm a mesma forma**, e vale nomear o padrão porque ele já apareceu quatro vezes numa auditoria só: *as duas pontas foram construídas e testadas, e o meio não existe.* Cada metade funciona; a ligação entre elas não; e nada percebe, porque nenhum teste percorre o caminho inteiro. O quinto caso foi encontrado e corrigido esta semana — o dashboard chamava `/api/progress/gamification` e nada respondia.

### 5.1 Os metadados pedagógicos não chegam a nenhuma decisão

`difficulty_tag`, `skill_tag`, `reasoning_type`, `distractor_error_code` e `pedagogical_rationale` têm coluna, validação e índice. **Nenhum `SELECT` no repositório lê qualquer um deles — e nada escreve valor neles.**

Medido: das **45 perguntas autoradas** do currículo, **zero** trazem qualquer um dos cinco campos. E o prompt de geração em `llm.ts` pede apenas pergunta, opções, resposta e explicação. O `snapshotItem` não infere nada — é passagem pura com defaults. Então no banco hoje `difficulty_tag` é `'medium'` em todo item, `skill_tag` e `reasoning_type` são `NULL`, `distractor_error_code` é `{}`.

O cano está vazio nas duas pontas. **Consumir esses campos sem antes produzi-los não distingue nada** — foi um erro na primeira versão deste documento, apontado na revisão do #51.

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

A resposta para isso **não é autoria manual de 132 conceitos.** São três vias — corpora abertos, contribuição colaborativa e geração — e é preciso separar o que cada uma resolve, porque elas não resolvem a mesma coisa.

**Exposição e avaliação são escassas de formas diferentes:**

| | O que é | Corpora abertos resolvem? |
|---|---|---|
| **Exposição** | Explicar, exemplificar, contextualizar | **Sim, e rápido.** É exatamente o que uma enciclopédia é |
| **Avaliação** | Pergunta com distratores que significam algo | **Quase nada.** Wikipedia não tem distratores, e nenhuma tem código de concepção equivocada |

O motor roda sobre **evidência**, e evidência vem de avaliação. Uma enciclopédia não produz evidência de aprendizagem — produz material para uma intervenção do tipo `explanation`.

Então ingerir Wikipedia move muito a coluna da esquerda e pouco a da direita. Os **9 de 141** continuam sendo 9 de 141 no dia seguinte à ingestão. Ainda assim vale muito: hoje 94% da exposição também é gerada do nada.

**A consequência mais forte não é cobertura, é fundamentação.** Se o modelo passa a *adaptar* conteúdo aberto verificado em vez de *inventar*, três coisas mudam de uma vez:

- **Alucinação deixa de ser a superfície principal.** O PR #24 existiu porque um item gerado podia ter `correctAnswer` que não correspondia a nenhuma opção. Reescrever uma fonte é um problema menor que inventar uma.
- **Nível de leitura vira o trabalho do modelo, não a fonte de erro.** Uma criança de 8 anos não lê o artigo da Wikipedia sobre frações. Adaptar registro é exatamente o que um modelo faz bem.
- **Existe a quem responsabilizar.** Uma explicação passa a ter fonte citável, o que a validação de conteúdo hoje não tem.

`generated` deixa de ser autor e vira tradutor. É o melhor uso do modelo disponível nesta arquitetura.

**Sobre grafos, não só texto:** o grafo de pré-requisitos é construído à mão, 141 nós. **Wikidata (CC0) e padrões curriculares abertos** — CASE/1EdTech, e a BNCC no caso brasileiro — já mapearam relações em outra ordem de grandeza. Para a *estrutura* eles servem melhor que prosa enciclopédica.

O pipeline colaborativo, que também existe, está quebrado no último metro — abaixo.

### 5.4 A contribuição aprovada nunca chega ao aluno

O pipeline colaborativo existe e é real: `api/contribute/lesson.ts`, `api/contribute/quiz.ts`, revisão por pares em `api/quality/review.ts`, reputação de contribuidor, e um estado `'deployed'` no schema.

**Nada escreve `'deployed'`.** Ele só é lido, como guarda. E nenhum caminho de código pega uma contribuição aprovada e a insere em `curriculum_concepts` ou `assessment_items`.

Um professor contribui uma prova. Dois revisores aprovam. Ela fica em `status='approved'` para sempre.

**Consequência:** a tese do grafo aberto e colaborativo é hoje aspiracional, não porque falte gente disposta, mas porque o último passo não existe. Fechar esse metro é barato — e é o que separa "queremos conteúdo colaborativo" de "temos conteúdo colaborativo".

### 5.5 Não existe procedência

Verificado: nem o `curriculum/schema.json` nem a interface `Concept` têm `source`, `url`, `license` ou `attribution`. O `explanation.text` é documentado como *"fonte de verdade para o tutor de IA"* — sem registro de de onde a verdade veio.

Enquanto todo o conteúdo era nosso ou gerado, isso era desleixo. **Assim que entrar conteúdo aberto, vira obrigação.**

- **Wikipedia é CC BY-SA.** Atribuição é exigida, e o *share-alike* é viral: derivados herdam a licença. Para um projeto aberto isso provavelmente até alinha, mas é decisão, não detalhe.
- **Wikidata é CC0.** Sem restrição — a razão pela qual ela é o melhor ponto de partida para a *estrutura* do grafo.
- **Grokipedia:** não sei quais são os termos atuais nem qual o regime de licenciamento, e não vou afirmar. **Precisa ser verificado antes de qualquer ingestão.** Vale também a diferença de processo: um corpus predominantemente gerado por IA não passou pelo escrutínio editorial que a Wikipedia tem, então a verificação humana pesa mais, não menos.

**Ingerir sem campo de procedência é redistribuir sem atribuição.** O modelo de procedência não é um item de organização — é pré-requisito legal do primeiro corpus aberto que entrar.

Ele também paga por si em pedagogia: quando um responsável contestar uma explicação, a resposta "veio deste artigo, nesta versão" é diferente de "o modelo escreveu".

## 6. Modelo de domínio

### 6.1 Knowledge State (nova abstração sobre o que já existe)

`progress` cumpre parte da função, mas conceitualmente ele é **progresso** — quanto o aluno andou. O que o motor precisa é **estado de conhecimento**: o que ele sabe, com que confiança, e há quanto tempo isso foi verificado.

```
knowledge_state  (por aluno × habilidade)
  mastery_estimate
  confidence
  retention_estimate
  evidence_count
  last_evidence_at
  source
  misconceptions
```

`progress` continua sendo a implementação inicial. A abstração é que muda.

**A maior parte disso já existe com outro nome** — e vale a tabela, porque separa o que é renomeação do que é trabalho:

| Campo | Hoje | Situação |
|---|---|---|
| `mastery_estimate` | `progress.mastery_score` | ✅ existe |
| `evidence_count` | `progress.attempts` | ✅ existe |
| `last_evidence_at` | `progress.last_attempt_at` | ✅ existe |
| `source` | `progress.mastery_source` | ✅ existe |
| `confidence` | `progress.mastery_confidence` | ⚠️ **existe e mente** — fixo em `1.0` para prova, `0.6` para nivelamento |
| `retention_estimate` | `review_interval_days`, `next_review_at` | ⚠️ **coisa diferente.** Um agendamento diz *quando perguntar de novo*; uma estimativa diz *qual a chance de ainda saber*. Hoje só existe o primeiro |
| `misconceptions` | — | ❌ **não existe**, e depende da onda 0.1a |

Duas conclusões práticas:

1. **Adotar Knowledge State é barato.** Cinco dos sete campos são renomeação de coisas que já estão no banco.
2. **Os dois que faltam são os que dão valor.** `confidence` real é o item 23 (BKT/Elo, adiado até haver dados — corretamente). `misconceptions` é o que torna a fila do professor possível, e é a onda 0.1.

### 6.2 Intervention (nova, primeira classe)

```
interventions
  id, type, target, source, content_ref,
  estimated_minutes, version, status

intervention_runs
  id, intervention_id, student_id, decision_id,
  reason, evidence, expected_outcome,
  started_at, completed_at, outcome, evidence_summary
```

`type`: `micro_lesson`, `practice`, `retrieval`, `diagnostic_probe`, `ai_tutoring`, `worked_example`, `explanation`, `teacher_action`, `external_resource`, `peer_activity`.

**`expected_outcome` é o campo mais importante desta tabela**, e o menos óbvio. Sem ele só dá para medir *o que aconteceu*. Com ele dá para medir *se a decisão estava certa* — a diferença entre telemetria e uma afirmação testável.

É o que torna respondível a pergunta que define o moat:

> Para alunos com o erro X no contexto Y, qual intervenção produz maior ganho **e maior retenção**?

Sem `expected_outcome` registrado antes do resultado, essa comparação é retrospectiva e enviesada — sempre se acha uma explicação para o que já aconteceu.

`reason` e `evidence` gravam *por que* esta intervenção foi escolhida e *sobre o que*, o que é a mesma exigência que `learning_decisions` já cumpre para decisões: uma escolha sobre alguém tem que poder ser contestada.

**Guardrail:** Intervention não pode virar "uma nova tabela de lesson". Se ela não representar ação humana, recurso externo e ação de IA com igual naturalidade, o desenho falhou.

### 6.3 Contrato de decisão

O motor deixa de responder `nextConcept` e passa a responder uma ação:

```json
{ "nextAction": { "type": "micro_practice",
                  "reason": "fragile_prerequisite",
                  "conceptId": "fractions-equivalence",
                  "interventionId": "...",
                  "policyVersion": 1 } }
```

`nextConcept` permanece internamente por compatibilidade.

### 6.4 Preservado sem alteração

Tentativas, respostas, snapshots imutáveis de item, `learning_decisions`, `progress`, revisão espaçada, grafo curricular, `staff_roles`, migrações versionadas, backup/restore, teto de LLM. **A recalibração não justifica reconstrução.**

### 6.5 Learning Event Contract (EDP-lite)

`learning_events` deixa de ser uma tabela de telemetria e passa a ser **vocabulário estável e versionado** dos acontecimentos pedagógicos.

```
event_id
schema_version
organization_id
student_id
actor_id
event_type
object_type / object_id
subject_id / concept_id
attempt_id / intervention_id
occurred_at
source
payload
```

**Não precisa de Kafka, data lake nem nenhuma outra forma sofisticada de transformar dinheiro em YAML.** SQLite e Turso servem no estágio atual. O que precisa existir é o *contrato*.

É o que permite depois — analytics, experimentos, avaliação do próprio motor, integrações, auditoria e pesquisa — **sem acoplar cada consumidor às tabelas operacionais**, que é o acoplamento que torna schema impossível de mudar.

Duas restrições que este documento mantém:

- **Não é event sourcing.** As tabelas operacionais continuam sendo a fonte de escrita; o stream é evidência e telemetria.
- **Não serve auditoria de segurança.** Login, mudança de papel e acesso administrativo querem append-only e imutabilidade, que são propriedades diferentes. Isso é o item 26 e precisa de tabela própria — misturar daria a pior versão de cada um.

E a pré-condição da seção 5.2 continua valendo: **o servidor precisa escrever no stream antes de o contrato significar alguma coisa.** Um vocabulário canônico sobre um stream que só o navegador alimenta canoniza os buracos.

## 7. Camada de IA

**Regra:** o motor pedagógico nunca pede "GPT" ou "Claude". Pede uma *capacidade*.

```
capacidade (tutor | explain | hint | generate_item | evaluate | classify)
        ↓
resolvedor de política (aluno > turma > organização > global)
        ↓
adaptador de provedor
```

**Estado atual:** `LLM_BASE_URL` é constante fixa apontando para a ATXP, **e o id do modelo está fixo em cinco lugares** como `claude-sonnet-4-6`. Trocar só a URL não basta: um servidor local compatível não expõe esse nome e recusa toda requisição. O item 0.3 precisa de seleção de modelo por capacidade, não de uma variável de ambiente. Ainda é pequeno; não é de cinco linhas, como esta seção afirmou antes. Política por escopo é outro tamanho e só paga quando houver escolas.

### 7.1 Telemetria de invocação — decisão tomada

A arquitetura-alvo pede auditoria por invocação. A pergunta era se esse registro carrega o aluno. **Decisão: não.**

O `recordUsage` guarda `purpose`, `model` e tokens, **sem id de usuário** — para que o teto de gasto exista sem construir um log de quem perguntou o quê e quando. O `/data` afirma isso ao usuário, e a afirmação continua verdadeira.

O motivo é que quase nada precisa da identidade:

| Uso | Precisa de quem? |
|---|---|
| Teto de gasto | ❌ tokens e janela bastam |
| Custo por escola, BYOK | `organization_id` — entidade pagante, não pessoa |
| Depurar política de modelo | `policy_id`, `capability`, escopo |
| Abuso | já coberto por `auth_attempts` e `guest_sessions` |
| Comparar modelos por resultado de aprendizagem | ✅ **precisa** — e está adiado por decisão |

**Acrescentar escopo, não pessoa.** `capability`, `policy_id`, `provider`, `latency_ms` e, quando houver escolas, `organization_id`.

**Quando o vínculo for necessário, ele não é `student_id`.** É `attempt_id` ou `intervention_run_id`:

- `attempt_id` diz **para que a chamada serviu** — uma tentativa, com começo e fim, já descrita no aviso. É delimitado.
- `student_id` diz **esta pessoa fez chamadas**, e acumula ao longo de tudo que ela fizer. Isso é perfil.

O primeiro responde *"esta explicação ajudou?"*. O segundo responde *"o que esta pessoa andou perguntando?"*. Só o primeiro é necessário para avaliar o motor.

**E o `/data` muda no mesmo PR, nunca depois.** O aviso mudar em seguida é a falha: é o que transforma uma promessa em coisa que a pessoa não tem como saber que expirou.

**Esta decisão ainda não é executável.** O teste do aviso de dados lê apenas `sqlite_master` — guarda classificação de **tabela**, não de coluna. Adicionar `student_id` a `llm_usage` amanhã passa no teste, e o `/data` segue afirmando que aquela tabela não guarda nada sobre pessoa. O invariante que falta é preciso e barato:

> Uma tabela declarada impessoal não pode ter chave estrangeira para `users`.

Sem ele, o que está escrito aqui é intenção, não garantia — e a garantia é o ponto.

## 8. Avaliação em três escalas

```
CONTÍNUA (respostas + mastery + revisão)
    → BENCHMARK (itens independentes, periódico)
        → EXTERNA (prova da escola, simulado)
```

O ganho é epistemológico: **o sistema deixa de avaliar apenas com instrumentos que ele mesmo ensinou.** Um relatório de divergência entre mastery interno e desempenho independente é a única forma de o motor estar errado em público.

Barato de começar e alto valor — por isso sobe na fila.

## 9. Camada escolar

```
Organization
 ├── Campus            (opcional)
 ├── AcademicTerm
 ├── Membership        (quem pertence à organização, e em que papel)
 └── Class
      ├── Teacher assignments
      └── Enrollment
```

**`Organization`, e não `School`.** Não é preciosismo: nomear "school" codifica o produto como *um app para uma escola*, e depois atender rede, secretaria, universidade, curso independente ou homeschool vira migração de schema em produção. É **decisão barata agora e cara depois** — a única razão de ela aparecer neste documento antes de ser implementada.

`Membership` separado de `Enrollment` pela mesma razão: pertencer a uma organização e estar matriculado numa turma são coisas diferentes, e um professor é o caso que prova.

**Não antes do piloto.** Adicionar `organization_id` significa reauditar o escopo de cada endpoint — a varredura de IDOR foi feita contra `student_id` e vínculo de responsável. É custo sem pagador enquanto não houver organização real.

---

## 10. Fila de PRs

Princípio: PRs pequenos, cada um com uma mudança de contrato testável. Não misturar tenancy, IA multi-provider e intervenção num refactor só.

### Onda 0 — tornar utilizável a evidência que já existe

*Nada novo. Só ligar o que está desconectado. É a onda de maior retorno por linha escrita.*

| # | PR | Critério de aceite |
|---|---|---|
| **0.1a** ✅ | **Produzir a evidência pedagógica** — [PR #52](https://github.com/LuizArgenta/open-alpha/pull/52) | O prompt de geração pede `distractorErrorCode` por opção errada, `skillTag` e `reasoningType`; a validação recusa item cujos códigos não cubram seus distratores. É de onde vem o dado para 94% do currículo. As 45 perguntas autoradas precisam de backfill — trabalho de conteúdo, e são 6%. |
| **0.1b** | **Consumir no diagnóstico** | `loadAttemptAnswers` carrega o código; `diagnoseAttempt` distingue *três erros pela mesma causa* de *três erros distintos*. Teste que falha se os dois casos derem o mesmo diagnóstico — e que roda contra o caminho real do item, não contra fixtures. |
| **0.2** | **Servidor como escritor de eventos** | Abrir tentativa, corrigir resposta, finalizar, decidir e conceder XP emitem evento. Teste: fazer uma prova sem o navegador reportar nada produz stream completo. |
| **0.3** | **Endpoint *e modelo* configuráveis** | `LLM_BASE_URL` **e** o id do modelo vêm da configuração, por capacidade, com a ATXP e `claude-sonnet-4-6` como padrão. Hoje o modelo está fixo em cinco lugares, então só tornar a URL configurável ainda quebra contra qualquer servidor local, que não expõe esse nome. Critério: sobe contra endpoint compatível servindo um modelo de nome próprio. |
| **0.4** | **Contribuição aprovada chega ao aluno** | Uma contribuição `approved` vira conceito ou item publicado e passa a `'deployed'`. Teste: professor contribui → dois revisores aprovam → um aluno senta a prova. Hoje esse teste é impossível de escrever. |

### Onda 1 — a mudança de contrato

| # | PR | Critério de aceite |
|---|---|---|
| 1.1 | ADR de vocabulário e non-goals | Este documento no repositório. Sem mudança de runtime. |
| 1.2 | Envelope canônico de evento v1 | `schema_version`, ids estáveis, idempotência. Eventos atuais compatíveis por adaptador. |
| 1.3 | `Intervention` + `InterventionRun` mínimas | Fluxo atual encapsulado como intervenção. Nada muda para o aluno. |
| 1.4 | Decisão retorna `nextAction` | Motor responde ação; `nextConcept` interno por compatibilidade. |
| 1.5 | Resultados de intervenção | `start`/`complete`/`outcome` alimentam stream e linha do tempo. |
| **1.6** | **Modelo de procedência** | `source`, `source_url`, `source_version`, `license` e `attribution` em conceito e intervenção. Teste: conteúdo sem procedência não publica. **Pré-requisito legal do 1.7**, não item de arrumação. |
| **1.7** | **Adaptador de conteúdo aberto** | Um corpus, ponta a ponta, com atribuição renderizada ao aluno. Começar por **Wikidata (CC0)** para estrutura de grafo — sem o *share-alike* da Wikipedia enquanto o modelo de licença é novo. Critério: um conceito importado é ensinável e citável. |
| **1.8** | **Geração fundamentada em fonte** | Quando existe conteúdo aberto para o conceito, o prompt **adapta** em vez de inventar, e a saída carrega a procedência da fonte. Reduz a superfície de alucinação e resolve nível de leitura. Depende de 1.6 e 1.7. |

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

- **Povoar o grafo em massa.** 9 de 141 conceitos com avaliação autorada. **Declaradamente não é o foco agora.** O que é foco é não fechar as portas: **0.4** (contribuição chega ao aluno) e **1.6–1.8** (conteúdo aberto entra com procedência). Depois disso, povoar é decisão de quando, não de se dá.

  Vale lembrar a assimetria da seção 5.3: corpora abertos movem muito a **exposição** e quase nada a **avaliação**. Os 9 de 141 continuam 9 de 141 no dia seguinte à ingestão.
- **LGPD operacional** (retenção, exportação, exclusão). O aviso existe; as três entregas não. **Bloqueia uso por menores**, não o piloto com adultos.
- **Item 13b** (Argon2id), **item 14** (sessões revogáveis). Autenticação, valem por si.
- `react-router` major.

### O que muda em relação ao memorando original

| | Memorando | Aqui | Por quê |
|---|---|---|---|
| Metadados no diagnóstico | ausente | **0.1a produz, 0.1b consome** | Pré-requisito não declarado do diferencial dele — e o cano está vazio nas duas pontas |
| Último metro da contribuição | ausente | **0.4** | Sem ele o grafo colaborativo é aspiracional |
| Corpora abertos como fonte | ausente | **1.6–1.8** | Via mais rápida para escala de exposição, e fundamenta a geração |
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
