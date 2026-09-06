# ADR-001 — Learning Event Contract v1

**Status:** aceito · **Onda:** 1 (itens 1.1 e 1.2) · **Substitui:** nada

## Contexto

`learning_events` nasceu como tabela de telemetria para o medidor de desperdício. A PRD v3 pede que ela vire outra coisa: **vocabulário estável e versionado** dos acontecimentos pedagógicos, para que analytics, experimentos, avaliação do próprio motor, integrações, auditoria e pesquisa possam ser escritos contra *o contrato* em vez de contra as tabelas operacionais — que é o acoplamento que torna schema impossível de mudar.

Três coisas estavam concretamente quebradas quando fui olhar:

1. **O vocabulário existia em três cópias e já tinha divergido.** `events.ts` declarava oito tipos, o `CHECK` no `db.ts` listava oito, e `progress/events.ts` tinha um array próprio com **sete** — sem `quiz_expired`. O navegador não conseguia reportar uma expiração que o servidor escreve, e nada em lugar nenhum comparava as listas.
2. **`created_at` fazia dois trabalhos** e errava um. O medidor de desperdício infere foco a partir dos *intervalos entre* eventos, e estava medindo intervalos entre os instantes em que as linhas foram inseridas. Um lote que chega atrasado lia como atividade concentrada que nunca aconteceu.
3. **O endpoint do navegador escrevia com `executeSql` puro**, fora da fila de escrita — a mesma classe de `SQLITE_BUSY` corrigida no PR #46 e reintroduzida por mim uma vez em `events.ts` — e era chamado por um `fetch(...).catch(() => {})`, a única forma em que uma retentativa é ao mesmo tempo provável e não contabilizada.

## Decisão

O contrato v1 vive em `api/_lib/event-contract.ts` e é a **única** definição do vocabulário. O `CHECK` do banco é construído a partir dela; o endpoint do navegador valida contra ela. Não há segunda lista.

Quatro colunas novas, cada uma porque algo está errado sem ela:

| Coluna | Por quê |
|---|---|
| `event_id` | Identidade própria do evento. O rowid é contador privado deste banco; qualquer consumidor externo, deduplicação ou reconciliação precisa de um id que a linha carregue consigo. |
| `schema_version` | Stream que ninguém consegue versionar é stream que ninguém consegue mudar. |
| `occurred_at` | Quando aconteceu, separado de `created_at`, quando soubemos. |
| `dedupe_key` | Token de retentativa do cliente, **único por aluno**. |

`dedupe_key` é separado de `event_id` de propósito. O desenho óbvio deixa o navegador fornecer o id do evento e o torna único — e com isso entrega a um aluno a capacidade de **suprimir o evento de outro** escrevendo o id dele primeiro. Sendo único por aluno, uma repetição só pode colidir com as linhas do próprio autor, e a identidade continua gerada pelo servidor e global.

Tempo reportado pelo cliente é **relato, não fato**: `credibleOccurredAt` descarta uma marcação fora da janela de tolerância em favor do relógio do servidor, porque o medidor de desperdício é visível ao aluno e a alternativa é um número que se define editando uma requisição.

Linhas escritas antes do contrato são lidas como envelopes v1 válidos pelo adaptador `toEnvelope`. Nenhum leitor precisa saber que o stream tem um antes e um depois.

## Non-goals

- **Não é event sourcing.** As tabelas operacionais continuam sendo a fonte de escrita; o stream é evidência e telemetria. Todo evento aqui é reconstruível a partir das linhas que descreve, e é isso que torna aceitável registrar em *best-effort*.
- **Não serve auditoria de segurança.** Login, mudança de papel e acesso administrativo querem append-only e imutabilidade — propriedades diferentes, com custos diferentes. Misturar daria a pior versão de cada um. É o item 26, com tabela própria.
- **Não é sincronização offline.** Nada de sync nesta onda. Só não fechamos a porta: ids globais, idempotência, eventos versionados.
- **Não precisa de Kafka nem data lake.** SQLite e Turso servem no estágio atual. O que precisa existir é o contrato.

## O que ficou de fora do v1, e por quê

`organization_id`, `actor_id`, `object_type`/`object_id` e `intervention_id` estão no envelope-alvo da PRD e **não** estão aqui. Cada um seria hoje escrito por nada e lido por nada.

Este projeto já encontrou cinco ocorrências exatamente dessa forma — as duas pontas construídas, o meio ausente, e nada percebendo — e a última estava dentro do teste escrito para prová-la. Colunas chegam junto com as entidades que lhes dão valor: `intervention_id` com `Intervention` no 1.3, `organization_id` com a camada escolar.

## Consequências

- Adicionar um tipo de evento passa a exigir migração que amplia o `CHECK`. Deliberado: o vocabulário não deve crescer por acidente dentro de um campo de payload onde nenhum leitor vai encontrá-lo.
- `recordEvent` continua sem lançar exceção, mas agora **reporta**: devolve `false` quando a escrita falhou. O endpoint cuja função inteira é registrar responde 500, e o cliente repete com a mesma chave. Todos os outros chamadores seguem ignorando o retorno, que é o comportamento correto para ambos.
- Consultas agregadas continuam em SQL. Puxar todas as linhas para JavaScript para contá-las seria mais lento e não mais honesto. `readEvents` é para leitores que percorrem eventos individuais — hoje, o medidor de desperdício.
