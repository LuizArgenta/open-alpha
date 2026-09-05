import { executeSql } from '../../../_lib/db.js';
import { childIdFromPath, isDenied, requireLinkedChild } from '../../../_lib/guardian.js';
import { subjects } from '../../../_lib/curriculum.js';

interface Progress {
  subject: string;
  concept_id: string;
  mastery_score: number;
  completed_at: string | null;
}

export async function GET(request: Request) {
  try {
    const access = await requireLinkedChild(request, childIdFromPath(request));
    if (isDenied(access)) return access;
    const childId = access.childId;



    const progressResult = await executeSql<Progress>(
      'SELECT subject, concept_id, mastery_score, completed_at FROM progress WHERE student_id = $1',
      [childId]
    );

    const summary = subjects.map(subject => {
      const subjectProgress = progressResult.rows.filter(p => p.subject === subject.id);
      const completed = subjectProgress.filter(p => p.mastery_score >= 80).length;
      const inProgress = subjectProgress.filter(p => p.mastery_score > 0 && p.mastery_score < 80).length;
      const totalConcepts = subject.concepts.length;

      return {
        subjectId: subject.id,
        subjectName: subject.name,
        completed,
        inProgress,
        notStarted: totalConcepts - completed - inProgress,
        totalConcepts,
        percentComplete: Math.round((completed / totalConcepts) * 100),
      };
    });

    return Response.json({ progress: progressResult.rows, summary });
  } catch (error) {
    console.error('Get child progress error:', error);
    return Response.json({ error: 'Failed to get child progress' }, { status: 500 });
  }
}
