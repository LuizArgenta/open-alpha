/**
 * Portuguese (Brazil) is the source of truth for translation keys: en.ts is
 * typed against it, so a key added here without an English counterpart fails
 * the build rather than falling back silently at runtime.
 *
 * Placeholders are {name} and are filled by t(key, params).
 */
export const ptBR = {
  // ── Common ────────────────────────────────────────────────────────────────
  'common.loading': 'Carregando...',
  'common.tryAgain': 'Tentar de novo',
  'common.goBack': 'Voltar',
  'common.cancel': 'Cancelar',
  'common.continue': 'Continuar',
  'common.save': 'Salvar',
  'common.saving': 'Salvando...',
  'common.saved': 'Salvo',
  'common.close': 'Fechar',
  'common.somethingWentWrong': 'Algo deu errado',

  // ── Language switcher ─────────────────────────────────────────────────────
  'language.label': 'Idioma',
  'language.pt-BR': 'Português',
  'language.en': 'English',

  // ── Header ────────────────────────────────────────────────────────────────
  'header.dashboard': 'Início',
  'header.settings': 'Configurações',
  'header.coach': 'Orientação',
  'header.signOut': 'Sair',

  // ── Grades ────────────────────────────────────────────────────────────────
  'grade.kindergarten': 'Ed. Infantil',
  'grade.nth': '{n}º ano',
  'grade.label': 'Ano escolar',

  // ── Auth ──────────────────────────────────────────────────────────────────
  'auth.login.title': 'Entrar',
  'auth.login.submit': 'Entrar',
  'auth.login.submitting': 'Entrando...',
  'auth.login.noAccount': 'Ainda não tem conta?',
  'auth.login.signUpLink': 'Criar conta',
  'auth.signup.title': 'Criar conta',
  'auth.signup.submit': 'Criar conta',
  'auth.signup.submitting': 'Criando conta...',
  'auth.signup.hasAccount': 'Já tem conta?',
  'auth.signup.loginLink': 'Entrar',
  'auth.signup.roleQuestion': 'Quem é você?',
  'auth.signup.roleStudent': 'Sou aluno',
  'auth.signup.roleParent': 'Sou responsável',
  'auth.email': 'E-mail',
  'auth.password': 'Senha',
  'auth.displayName': 'Nome',
  'auth.displayNameOptional': 'Nome (opcional)',

  // ── Student dashboard ─────────────────────────────────────────────────────
  'student.greeting': 'Olá, {name}!',
  'student.chooseSubject': 'Escolha uma matéria',
  'student.dueForReview': 'Hora de revisar',
  'student.review': 'Revisar',
  'student.daysAgo': 'há {days}d',
  'student.conceptsMastered': '{mastered} de {total} conceitos',
  'student.continueLearning': 'Continuar',
  'student.start': 'Começar',
  'student.editInterests': 'Editar meus interesses',

  // ── Learn ─────────────────────────────────────────────────────────────────
  'learn.subjects': 'Matérias',
  'learn.allSubjects': 'Todas as matérias',
  'learn.lessons': 'Aulas',
  'learn.lesson': 'Aula',
  'learn.tutor': 'Tutor',
  'learn.quiz': 'Prova',
  'learn.takeQuiz': 'Fazer a prova',
  'learn.upNext': 'A seguir',
  'learn.mastery': 'Domínio:',
  'learn.selectLesson': 'Escolha uma aula à esquerda para começar',
  'learn.loadingConcepts': 'Carregando conceitos...',
  'learn.loadError.title': 'Não foi possível carregar os conceitos',
  'learn.loadError.message': 'Tivemos um problema ao carregar o conteúdo. Tente de novo.',
  'learn.generating.title': 'Escrevendo sua aula...',
  'learn.generating.body': 'A IA está preparando uma aula sobre {concept}. Isso leva alguns segundos na primeira vez — depois fica instantâneo para todo mundo.',
  'learn.explainLevel': 'Explique como se eu fosse:',
  'learn.level.eli5': 'Criança',
  'learn.level.standard': 'Padrão',
  'learn.level.expert': 'Avançado',
  'learn.advanceBanner': 'Boa! Seguindo para {concept}...',

  // ── Quiz ──────────────────────────────────────────────────────────────────
  'quiz.generating': 'Preparando a prova...',
  'quiz.loadError': 'Não foi possível carregar a prova',
  'quiz.correct': 'Certo!',
  'quiz.incorrect': 'Não é bem isso',
  'quiz.reviewLesson': '← Rever a aula',
  'quiz.nextQuestion': 'Próxima pergunta',
  'quiz.seeResults': 'Ver resultado',
  'quiz.passedTitle': 'Parabéns!',
  'quiz.failedTitle': 'Vamos praticar mais!',
  'quiz.scored': 'Você acertou {score}%',
  'quiz.correctCount': '{correct} de {total} corretas',
  'quiz.mastered': 'Você dominou {concept}!',
  'quiz.needMore': 'Você precisa de 80% para dominar este conceito. Continue estudando e tente de novo!',
  'quiz.whatToDoNext': 'O que fazer agora',
  'quiz.reviewConcept': 'Revisar {concept}',
  'quiz.reviewEarlier': 'Revisar o conceito anterior',
  'quiz.backToLearning': 'Voltar a estudar',
  'quiz.continueLearning': 'Continuar estudando',

  // ── Remediation coming from the engine (Phase 1) ──────────────────────────
  'remediation.reviewPrerequisite': 'Vamos revisar {concept} primeiro — é a base deste conceito.',

  // ── Attempt diagnosis (Phase 3) ───────────────────────────────────────────
  'diagnosis.rapidGuessing': 'Você respondeu {rapid} de {total} perguntas em menos de {seconds} segundos. Vá com calma e leia cada uma — assim essa nota ainda não diz o que você sabe.',
  'diagnosis.distraction': 'Parece que você saiu no meio da prova. Tente de novo de uma vez só, para o resultado refletir o que você sabe.',

  // ── Focus meter (Phase 4) ─────────────────────────────────────────────────
  'focus.title': 'Medidor de foco',
  'focus.lockedIn': 'Concentrado',
  'focus.stayFocused': 'Atenção',
  'focus.tooMuchWaste': 'Muita distração',
  'focus.notCountedToday': 'não contou hoje',
  'focus.reason.rapidGuessing': '{rapid} de {total} respostas vieram mais rápido do que dá para ler a pergunta',
  'focus.reason.walkedAway': '{count} pausa longa no meio da prova',
  'focus.reason.walkedAway_plural': '{count} pausas longas no meio da prova',
  'focus.reason.lowAccuracy': 'menos de 40% de acerto em {total} respostas',
  'focus.contest.rapidGuessing': 'Não foi chute',
  'focus.contest.walkedAway': 'Eu ainda estava estudando',

  // ── Timeback (Phase 4) ────────────────────────────────────────────────────
  'timeback.earnTitle': 'Conquiste seu tempo livre',
  'timeback.earnedTitle': 'Você conquistou seu tempo livre!',
  'timeback.minutesFocused': '{minutes} min de foco hoje',
  'timeback.minutesEarned': '{minutes} min conquistados',
  'timeback.minutesRemaining': 'faltam {minutes} min',
  'timeback.focusBonus': 'Bônus de foco de 1,25x ativo — terminando mais rápido!',
  'timeback.conceptsToday': 'conceitos hoje',
  'timeback.accuracy': 'acerto',
  'timeback.hintsUsed': 'dicas usadas',

  // ── Parent dashboard ──────────────────────────────────────────────────────
  'parent.childProgress': 'Progresso de {name}',
  'parent.selectChild': 'Selecione uma criança',
  'parent.lastActive': 'Última atividade: {when}',
  'parent.needsAttention': 'Precisa de atenção',
  'parent.needsExtraHelp': 'Precisa de ajuda',
  'parent.recommendedNext': 'Próximos passos sugeridos',
  'parent.recentActivity': 'Atividade recente',
  'parent.linkChild': 'Vincular uma criança',
  'parent.linkCodePlaceholder': 'ABCD1234',
  'parent.link': 'Vincular',

  // ── Alerts for the adult (Phase 6) ────────────────────────────────────────
  'alert.stuck.title': 'Travado em {concept}',
  'alert.stuck.detail': '{attempts} tentativas, ainda em {score}%. Já foi levado de volta a um conceito anterior para preencher a lacuna — vale sentar junto neste.',
  'alert.retentionDrop.title': '{concept} escapou',
  'alert.retentionDrop.detail': 'Tinha sido dominado e foi errado numa verificação posterior. Voltou para a fila de revisão.',
  'alert.reviewsOverdue.title': '{count} conceito para revisar',
  'alert.reviewsOverdue.title_plural': '{count} conceitos para revisar',
  'alert.reviewsOverdue.detail': 'O mais antigo espera há {days} dia, começando por {concept}.',
  'alert.reviewsOverdue.detail_plural': 'O mais antigo espera há {days} dias, começando por {concept}.',
  'alert.reviewsOverdue.detailToday': 'Começando por {concept}.',
  'alert.inactive.title': 'Sem atividade há {days} dias',
  'alert.inactive.detail': 'Revisão espaçada só funciona se as revisões acontecerem.',
  'alert.neverStarted.title': 'Ainda sem sessões',
  'alert.neverStarted.detail': 'Ainda não começou nenhuma sessão.',

  // ── XP ────────────────────────────────────────────────────────────────────
  'xp.title': 'XP de hoje',
  'xp.progress': '{earned} de {goal} XP',
  'xp.goalReached': 'Meta do dia batida!',
  'xp.earned': '+{amount} XP',
  'xp.reason.mastery_focused': 'Dominado com foco',
  'xp.reason.mastery_first_try': 'Gabaritou de primeira',
  'xp.reason.mastery_partial': 'Dominado, mas com alguma distração',
  'xp.reason.mastery_wasteful': 'Dominado com muita distração',
  'xp.reason.no_mastery': 'Sem XP: o conceito ainda não foi dominado',
  'xp.reason.gaming': 'Sem XP: as respostas vieram no chute',

  // ── Settings ──────────────────────────────────────────────────────────────
  'settings.title': 'Configurações',
  'settings.profile': 'Perfil',
  'settings.updateGrade': 'Mudar ano escolar',
  'settings.gradeHelp': 'Se quiser rever conteúdo anterior, você sempre pode voltar a qualquer conceito na tela de estudo.',
  'settings.inviteCode': 'Código de convite',
  'settings.generateInvite': 'Gerar código para meu responsável',
  'auth.tagline': 'Tutoria com IA, gratuita, para quem quiser aprender',
  'auth.login.redirecting': 'Redirecionando...',
  'auth.login.signInWithAtxp': 'Entrar com ATXP',
  'auth.login.newHere': 'Novo por aqui?',
  'student.welcomeBack': 'Que bom te ver de novo{name}!',
  'student.loadingProgress': 'Carregando seu progresso...',
  'student.loadError.title': 'Não foi possível carregar seu painel',
  'student.loadError.message': 'Tivemos um problema ao carregar seu progresso. Tente de novo.',
  'settings.namePlaceholder': 'Como podemos te chamar?',
  'settings.saveError': 'Não foi possível salvar as alterações',
  'settings.inviteHelp': 'Dê este código para seu pai, mãe ou responsável vincular a conta dele à sua.',
} as const;

export type TranslationKey = keyof typeof ptBR;
export type Dictionary = Record<TranslationKey, string>;
