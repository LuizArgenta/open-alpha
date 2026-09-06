# PRD — Motor de Aprendizagem Adaptativa (upgrade inspirado na Alpha School / 2 Hour Learning)

**Escopo:** só software/pedagogia. Nada de modelo de negócio, preço, expansão ou operação física — isso fica fora deste documento de propósito.


> **Nota de 6 de setembro de 2026.** Este documento permanece **como está**: é a constituição do motor pedagógico. Quatro decisões suas seguem sendo a base e não são revisadas pelo [PRD v3](./PRD-v3-motor-de-intervencao.md) — motor determinístico antes do LLM, retenção como parte do domínio, diagnóstico do tipo de erro, e intervenção humana orientada por sinal em vez de métrica crua.
>
> O v3 amplia o enquadramento em volta dele; não substitui nada daqui.

**Objetivo:** o Open Alpha já tem um grafo de currículo com pré-requisitos e um limiar de mastery (80%). O que falta é o que o relatório sobre a Alpha chama de "motor de decisão": um sistema que usa o histórico real do aluno (não só "passou/não passou") para decidir o próximo passo, cobrar retenção ao longo do tempo, e dar ao humano que acompanha (professor/pai) sinal acionável em vez de métricas cruas.

---

## Princípios de design (não negociáveis)

1. **Dados mínimos, decisão máxima.** Nada de webcam, tela, áudio, biometria ou geolocalização — o relatório da Alpha é claro que essa é a maior fonte de risco do modelo, e não agrega precisão de aprendizagem que os sinais existentes (resposta, tempo, tentativas, hints) já não deem.
2. **Regras determinísticas primeiro, LLM só na ambiguidade.** Decisão de "próximo conceito" e "tipo de erro" deve ser majoritariamente heurística/consultas SQL. LLM entra para gerar conteúdo e para classificar os casos que a heurística não resolve. Isso mantém custo e latência previsíveis.
3. **Cada mecanismo tem que ser contestável e transparente para o aluno.** Se o sistema marca "desperdício" ou redireciona para um pré-requisito, o aluno vê o porquê.
4. **Reaproveitar o que já existe.** O schema de currículo (`curriculum/schema.json`) já modela `remediationPath`, `guidedPractice` com hints/feedback e `masteryCheck` — hoje esses campos existem nos dados mas boa parte não é consumida pela API/frontend. Fase 1 é essencialmente *ligar o que já foi desenhado*, não inventar campos novos.

---

## Linha de base atual (o que existe hoje, sem retoque)

| Peça | Onde está | Estado real |
|---|---|---|
| Grafo de pré-requisitos | `curriculum/*.json`, `api/_lib/curriculum.ts` | Funciona, mas `getNextConcept` só olha se o pré-requisito foi "mastered" (score ≥ 80) — ignora quantas tentativas, quão recente, ou se caiu depois |
| Remediação ao errar | `remediationPath` no schema, presente nos JSONs e no `_lib/curriculum.ts` | **Existe no dado, não é lido em nenhum lugar do frontend nem do `quiz/submit.ts`.** Hoje quem erra só recebe "Keep practicing to reach 80% mastery." |
| Retenção / esquecimento | — | **Não existe.** Um conceito "mastered" nunca é revisitado. Não há campo de data de próxima revisão |
| Sinal de foco/desperdício | `learning_events`, `api/progress/timeback.ts`, `WasteMeter.tsx` | Existe e funciona, mas é heurística simples (resposta <3s = chute; ociosidade conta pontos) sem calibração por tipo de pergunta, e o aluno não vê o porquê de forma explicável |
| Geração de conteúdo (Incept-like) | `curriculum/schema.json`, `curriculum/validate.js`, `api/curriculum/lesson.ts` | Schema é rigoroso para currículo *contribuído via PR* (tem validador), mas a geração via LLM em tempo real não roda essa mesma validação antes de cachear — pode salvar lição malformada |
| Painel humano | `ParentDashboard.tsx` | Mostra progresso bruto por assunto, não sinais de "aluno travado aqui" ou "não revisita há X dias" |

---

## O que trazer da Alpha vs. o que deixar de fora

| Componente Alpha | Trazer? | Por quê |
|---|---|---|
| Motor de decisão (TimeBack) usando acerto+tentativas+tempo+retenção | **Sim — núcleo do PRD** | É o verdadeiro diferencial do modelo, segundo o próprio relatório (não é o LLM) |
| Recuperação espaçada / revisão programada | **Sim** | Item da literatura com evidência mais sólida (Roediger & Karpicke, Cepeda et al.) e hoje inexistente |
| Diagnóstico de tipo de erro (lacuna vs distração vs dificuldade) | **Sim, de forma leve** | Só heurística + LLM para casos ambíguos, como a Alpha faz (seção 5.7 do relatório) |
| Geração de conteúdo restrita por rubrica/validador (Incept) | **Sim** | Já temos o schema; falta aplicá-lo no caminho de geração em tempo real |
| Painel priorizando decisão humana, não volume de métricas | **Sim** | Necessário para o professor/pai realmente agir |
| Captura de tela/webcam/áudio, biometria, OCR de comportamento | **Não** | Maior risco de governança do relatório; não melhora acurácia de aprendizagem no seu contexto |
| Recompensas em dinheiro / "Alpha Bucks" | **Não** | Não é software; é incentivo — fora do escopo deste PRD |
| Personalização ilimitada por interesse (Taylor Swift, futebol etc. em tudo) | **Manter como tempero, não como eixo** | Já existe (`InterestSetup.tsx`); relatório alerta para risco de "bolha" — personalização deve ser ponte, não destino |
|Ife Skills / workshops à tarde | **Não é software** | Fora de escopo por definição |

---

## Fases de implementação

Ordenadas por relação custo/benefício, não por dependência estrita — mas 1 e 2 devem vir antes das demais porque tudo o resto se apoia nesses sinais.

### Fase 0 — Pré-requisito técnico (curtíssima, não é o foco do PRD)
Corrigir o fallback inseguro de `JWT_SECRET` em `api/_lib/auth.ts` antes de expandir a superfície da aplicação. Meio dia de trabalho, zero relação com pedagogia, mas evita construir o motor adaptativo sobre uma base com token forjável.

### Fase 1 — Motor de decisão adaptativo (o coração do upgrade)
**O que muda:**
- `getNextConcept` deixa de olhar só `mastery_score >= 80` e passa a considerar: tentativas, `last_attempt_at`, e se existe `remediationPath` acionável quando o aluno falhou o último `masteryCheck`.
- `api/tutor/quiz/submit.ts` passa a retornar o `remediationPath` do conceito quando `passed = false` (o dado já existe, só falta expor).
- `Quiz.tsx` / `Learn.tsx` mostram a mensagem e ação de `remediationPath` (voltar a um pré-requisito específico, explicação mais simples, prática extra) em vez do genérico "keep practicing".

**Esforço:** médio (é principalmente fiação entre dado já existente e UI/API; pouca lógica nova).
**Impacto:** alto — transforma o grafo de estático em adaptativo de fato.
**Critério de sucesso:** quando um aluno falha um `masteryCheck`, ele é roteado para uma ação específica (não genérica) em >90% dos casos onde `remediationPath` está definido no conteúdo.

### Fase 2 — Recuperação espaçada
**O que muda:**
- Novo campo `next_review_at` na tabela `progress` (migração simples, mesmo padrão das migrações já existentes em `db.ts`).
- Algoritmo simples tipo Leitner (não precisa de SM-2 completo): cada revisão bem-sucedida dobra o intervalo até a próxima; uma falha reseta.
- `StudentDashboard`/`Learn` passam a sugerir, ao lado do "próximo conceito novo", os conceitos "devidos para revisão" — reaproveitando o mesmo componente de quiz curto (5 perguntas) já existente.

**Esforço:** baixo-médio.
**Impacto:** alto — é o item de maior evidência científica isolada (mastery learning sozinho não garante retenção; isso é o que garante).
**Critério de sucesso:** existe, pela primeira vez, um número mensurável de "retenção aos 30/90 dias" por conceito — hoje esse dado simplesmente não existe no sistema.

### Fase 3 — Diagnóstico leve de tipo de erro
**O que muda:**
- Ao registrar uma resposta errada em `learning_events`, classificar heuristicamente: chute rápido (já existe via Waste Meter), muitas tentativas no mesmo item (dificuldade real), erro após uso de hint (lacuna conceitual ainda não resolvida), erro isolado sem hint (pode ser distração).
- Só cair para uma chamada de LLM quando a heurística não decidir (ex: padrão ambíguo) — espelha a arquitetura híbrida da Alpha (regra primeiro, modelo depois).
- Esse rótulo alimenta a decisão da Fase 1: "lacuna conceitual" → `remediationPath`; "distração" → só um lembrete, sem mudar o caminho.

**Esforço:** médio.
**Impacto:** médio-alto — evita que o motor trate todo erro do mesmo jeito.

### Fase 4 — Waste/Timeback honesto e contestável
**O que muda:**
- Melhorar a calibração do `wasteScore` (hoje é um limiar fixo de 3s para "chute rápido" e uma contagem simples de ociosidade) usando o `estimatedMinutes` que já existe em `metadata` no schema de currículo, para normalizar por dificuldade esperada do item.
- Adicionar na UI (`WasteMeter.tsx`) uma explicação de *por que* aquele score saiu daquele jeito, e permitir o aluno marcar "isso não foi um chute, eu já sabia" — vira sinal de contestação, não só de vigilância.

**Esforço:** baixo-médio (componente já existe, é calibração + uma interação nova).
**Impacto:** médio — mais motivacional/confiança do que acurácia pura de aprendizagem, mas barato de fazer e já está no caminho.

### Fase 5 — Guardrails de geração de conteúdo (Incept-like)
**O que muda:**
- `api/curriculum/lesson.ts` (geração em tempo real) passa a validar o JSON gerado contra `curriculum/schema.json` — o mesmo validador que já existe em `curriculum/validate.js` para currículo contribuído — antes de gravar em `generated_lessons`.
- Em caso de falha de validação, uma retentativa automática com o erro específico anexado ao prompt (não expor erro cru ao aluno).

**Esforço:** baixo (reaproveita validador existente).
**Impacto:** médio — impede que lição malformada fique cacheada e sirva para todos os alunos daquele conceito indefinidamente.

### Fase 6 — Painel do "Guide" (professor/pai)
**O que muda:**
- `ParentDashboard.tsx` (e, se houver visão de professor futuramente) passa a priorizar alertas acionáveis: "aluno travado neste conceito há N tentativas", "não revisita nada há X dias", "queda de retenção nesta área" — em vez de uma lista de percentuais.
- Consome diretamente os dados já produzidos pelas Fases 1–3, sem precisar de infraestrutura nova.

**Esforço:** médio.
**Impacto:** médio-alto para uso real em sala — é o que permite um humano agir sobre o que o motor decidiu, em vez de só assistir.

---

## Métricas norte (como saber se ficou "mais eficiente e acurado")

- **Taxa de retry após primeira tentativa de mastery** — deve cair conforme a remediação (Fase 1) fica mais específica.
- **Retenção em 30/90 dias** por conceito — inexistente hoje; passa a existir com a Fase 2. É a métrica mais importante e a que falta por completo.
- **Tempo até mastery por conceito** — deve ficar mais previsível (menos alunos "travados" sem saída).
- **Correlação entre Waste Score e desempenho real** — serve para checar se o sinal de foco realmente prediz aprendizagem, não só comportamento na tela.

## Fora de escopo, de propósito

Webcam/tela/áudio/biometria, recompensas monetárias, OCR de comportamento, personalização por interesse como eixo central, e qualquer coisa de modelo de negócio/expansão — nenhum desses itens entra neste documento nem é necessário para as fases acima.
