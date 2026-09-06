# Desenho do item 20 — seleção de itens

Desenho, não implementação. Escrito durante a auditoria do [PR #32](https://github.com/LuizArgenta/open-alpha/pull/32), que entrega o banco de itens (item 19) e deixa o gancho pronto: `selectMasteryItems(pool, random)` sorteia uniforme e documenta que o resto é este item.

Documento relacionado: [Plano de execução](./PLANO-DE-EXECUCAO.md) · item 20.

---

## O alvo

Manter o acerto do aluno entre **80% e 85%**.

Não é um número inventado aqui: é o alvo que o caminho de geração por LLM já persegue, via `recentAccuracy` em `api/tutor/quiz.ts`. Se o pool autorado usar outro alvo, a plataforma passa a ter **duas pedagogias diferentes** conforme o conceito tenha ou não banco de itens — e ninguém vai perceber, porque as duas produzem provas de cinco questões que parecem iguais.

---

## As três restrições, em ordem de precedência

### 1. Não repetir item recente (dureza alta)

Item que o aluno respondeu nas últimas **2 tentativas** daquele conceito não entra no sorteio.

Contagem de tentativas, não janela de tempo: janela de tempo pune quem estuda em bloco, que é exatamente o comportamento que a plataforma quer permitir. Um aluno que faz três tentativas numa tarde não deveria ver os mesmos itens só porque as três couberam em duas horas.

Requer ler `assessment_attempt_items` cruzado com `assessment_attempts.student_id` — hoje não há índice para isso.

### 2. Teto de exposição (dureza média)

Nenhum item pode aparecer em mais de **X%** das tentativas daquele conceito, contando todos os alunos.

Sem isso o pool colapsa: o sorteio uniforme tende a concentrar nos itens que sempre estiveram lá, os novos entram pouco, e um banco de 30 itens se comporta como um banco de 8. Também é o que protege contra o item vazar — se um item aparece em 90% das provas, ele circula entre os alunos.

Requer um contador de exposição por item.

### 3. Mira de dificuldade (dureza baixa — é preferência, não regra)

Composição-alvo derivada do domínio atual do aluno: abaixo do limiar recebe mais `easy`, acima recebe mais `hard`. **Nunca cinco itens da mesma faixa** — uma prova homogênea não distingue "não sabe nada" de "não sabe o difícil".

---

## O conflito que precisa ser declarado, não descoberto em produção

As três restrições são **insatisfazíveis simultaneamente em pool pequeno**. O mínimo do #32 é 5 itens e o sorteio pede 5: com exatamente 5, não existe escolha nenhuma — não há como não repetir, não há como limitar exposição, não há como mirar dificuldade.

Isso não é caso raro. É o caso **mediano** hoje: dos 141 conceitos, 9 têm `masteryCheck`, e o mínimo é 5.

Então o desenho tem de declarar a ordem de degradação, em vez de deixar o comportamento emergir do código:

1. Solta a **mira de dificuldade** primeiro (é preferência).
2. Solta o **teto de exposição** depois.
3. **Nunca** solta o não-repetir enquanto houver item elegível — repetir item é o que o aluno percebe, e é o que mais rápido destrói a confiança dele na prova.
4. Quando nem isso for possível (pool = 5), repete e **registra que repetiu**.

**Registrar qual restrição foi relaxada é parte do item, não um extra.** Sem isso, ninguém consegue responder "por que meu filho viu a mesma questão duas vezes" — e essa é exatamente a pergunta que o painel do responsável promete responder.

---

## O que registrar por sorteio

Em `learning_decisions`, com `kind: 'item_selection'`:

- itens candidatos (o pool elegível)
- itens escolhidos
- restrição relaxada, se alguma
- alvo de dificuldade usado e domínio que o produziu

Sem isso o sorteio é irreprodutível, e o item 21 (nivelamento adaptativo) não tem como ser calibrado depois — calibrar exige saber o que o algoritmo *podia* ter escolhido, não só o que escolheu.

---

## Pré-condição que não é código

**O item 20 só produz efeito com pool consideravelmente maior que 5.** Com pool de 5 ele é uma reordenação sem consequência: as mesmas cinco questões, em ordem diferente.

Aumentar o pool é trabalho de autoria pedagógica, não de engenharia — pertence à seção "Fora de PR" do plano, junto do mapeamento BNCC. Implementar o item 20 antes disso entrega código correto e efeito nulo, e ainda dá a impressão de que a seleção adaptativa está resolvida.

A ordem honesta é: primeiro alguém escreve itens, depois o item 20 tem o que selecionar.
