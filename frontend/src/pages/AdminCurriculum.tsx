import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../App';
import { useServerText, useTranslation } from '../i18n';
import CurriculumHealthBanner from '../components/CurriculumHealthBanner';

interface SubjectSummary {
  id: string;
  name: string;
  description: string;
  status: 'draft' | 'in_review' | 'published';
  concepts: number;
  publishedConcepts: number;
}

interface ConceptSummary {
  id: string;
  name: string;
  level: number;
  prerequisites: string[];
  status: string;
  version: number;
}

interface GraphProblem {
  conceptId: string;
  code: string;
  detail: string;
}

export default function AdminCurriculum() {
  const { token } = useAuth();
  const { t } = useTranslation();
  const serverText = useServerText();

  const [subjects, setSubjects] = useState<SubjectSummary[] | null>(null);
  const [authorized, setAuthorized] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [concepts, setConcepts] = useState<ConceptSummary[]>([]);
  const [problems, setProblems] = useState<GraphProblem[]>([]);
  const [error, setError] = useState('');

  const [newSubject, setNewSubject] = useState({ id: '', name: '' });
  const [newConcept, setNewConcept] = useState({ id: '', name: '', level: 1, prerequisites: [] as string[] });

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const loadSubjects = useCallback(async () => {
    const res = await fetch('/api/admin/curriculum/subjects', { headers });
    if (res.status === 403) {
      setAuthorized(false);
      setSubjects([]);
      return;
    }
    const data = await res.json();
    setSubjects(data.subjects ?? []);
  }, [token]);

  const loadConcepts = useCallback(async (subjectId: string) => {
    const res = await fetch(`/api/admin/curriculum/concepts?subject=${subjectId}`, { headers });
    const data = await res.json();
    setConcepts(data.concepts ?? []);
    setProblems(data.problems ?? []);
  }, [token]);

  useEffect(() => { loadSubjects(); }, [loadSubjects]);
  useEffect(() => { if (selected) loadConcepts(selected); }, [selected, loadConcepts]);

  async function post(url: string, body: unknown) {
    setError('');
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await res.json();

    if (!res.ok) {
      // The API explains graph problems precisely; a generic failure message
      // would throw that away.
      setError(data.problems?.map((p: GraphProblem) => p.detail).join(' · ') ?? data.error ?? t('admin.saveFailed'));
      return false;
    }
    return true;
  }

  if (!authorized) {
    return (
      <div className="container" style={{ padding: '3rem 1rem', maxWidth: '640px' }}>
        <div className="card">{t('admin.notAuthorized')}</div>
      </div>
    );
  }

  if (!subjects) return null;

  const current = subjects.find(subject => subject.id === selected);

  return (
    <div className="container" style={{ padding: '2rem 1rem', display: 'grid', gap: '1.5rem', gridTemplateColumns: 'minmax(220px, 300px) 1fr' }}>
      <CurriculumHealthBanner />

      <section>
        <h3 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '0.75rem' }}>{t('admin.subjects')}</h3>

        <div className="card" style={{ padding: '0.5rem', marginBottom: '1rem' }}>
          {subjects.map(subject => (
            <button
              key={subject.id}
              onClick={() => setSelected(subject.id)}
              style={{
                display: 'block', width: '100%', textAlign: 'left', border: 'none',
                borderRadius: '0.375rem', cursor: 'pointer', padding: '0.5rem 0.625rem',
                background: selected === subject.id ? 'var(--primary)' : 'transparent',
                color: selected === subject.id ? 'white' : 'var(--text)',
              }}
            >
              <div style={{ fontWeight: 500, fontSize: '0.9375rem' }}>{subject.name}</div>
              <div style={{ fontSize: '0.75rem', opacity: 0.8 }}>
                {serverText(`admin.status.${subject.status}`, undefined, subject.status)} ·{' '}
                {t('admin.conceptCount', { published: subject.publishedConcepts, total: subject.concepts })}
              </div>
            </button>
          ))}
        </div>

        <div className="card">
          <h4 style={{ fontWeight: 600, fontSize: '0.9375rem', marginBottom: '0.5rem' }}>{t('admin.newSubject')}</h4>
          <input className="input" placeholder={t('admin.subjectId')} value={newSubject.id}
            onChange={e => setNewSubject({ ...newSubject, id: e.target.value })} style={{ marginBottom: '0.5rem' }} />
          <input className="input" placeholder={t('admin.subjectName')} value={newSubject.name}
            onChange={e => setNewSubject({ ...newSubject, name: e.target.value })} style={{ marginBottom: '0.5rem' }} />
          <button className="btn btn-primary" style={{ width: '100%' }}
            onClick={async () => {
              if (await post('/api/admin/curriculum/subjects', newSubject)) {
                setNewSubject({ id: '', name: '' });
                loadSubjects();
              }
            }}>
            {t('admin.create')}
          </button>
        </div>
      </section>

      <section>
        {!current ? (
          <div className="card">{t('admin.selectSubject')}</div>
        ) : (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', gap: '0.75rem', flexWrap: 'wrap' }}>
              <h3 style={{ fontSize: '1.125rem', fontWeight: 600 }}>
                {t('admin.concepts', { subject: current.name })}
              </h3>
              <button
                className="btn btn-primary"
                onClick={async () => {
                  const unpublish = current.status === 'published';
                  if (await post('/api/admin/curriculum/publish', { subjectId: current.id, unpublish })) {
                    loadSubjects();
                    loadConcepts(current.id);
                  }
                }}
              >
                {current.status === 'published' ? t('admin.unpublish') : t('admin.publish')}
              </button>
            </div>

            {error && (
              <div className="card" style={{ borderColor: 'var(--error)', color: 'var(--error)', marginBottom: '0.75rem', fontSize: '0.875rem' }}>
                {error}
              </div>
            )}

            {problems.length > 0 && (
              <div className="card" style={{ borderColor: '#f59e0b', marginBottom: '0.75rem' }}>
                <strong style={{ fontSize: '0.875rem' }}>{t('admin.problems')}</strong>
                <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem', fontSize: '0.8125rem' }}>
                  {problems.map((problem, i) => <li key={i}>{problem.detail}</li>)}
                </ul>
              </div>
            )}

            <div className="card" style={{ marginBottom: '1rem' }}>
              {concepts.length === 0 ? (
                <p style={{ fontSize: '0.875rem', color: 'var(--text-light)' }}>{t('admin.noConcepts')}</p>
              ) : (
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {concepts.map(concept => (
                    <li key={concept.id} style={{ padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
                      <div style={{ fontWeight: 500, fontSize: '0.9375rem' }}>
                        {concept.name}{' '}
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-light)' }}>
                          · {t('admin.conceptLevel')} {concept.level} ·{' '}
                          {serverText(`admin.status.${concept.status}`, undefined, concept.status)}
                        </span>
                      </div>
                      {concept.prerequisites.length > 0 && (
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-light)' }}>
                          ← {concept.prerequisites.join(', ')}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="card">
              <h4 style={{ fontWeight: 600, fontSize: '0.9375rem', marginBottom: '0.5rem' }}>{t('admin.newConcept')}</h4>
              <input className="input" placeholder={t('admin.conceptId')} value={newConcept.id}
                onChange={e => setNewConcept({ ...newConcept, id: e.target.value })} style={{ marginBottom: '0.5rem' }} />
              <input className="input" placeholder={t('admin.conceptName')} value={newConcept.name}
                onChange={e => setNewConcept({ ...newConcept, name: e.target.value })} style={{ marginBottom: '0.5rem' }} />
              <input className="input" type="number" min={0} placeholder={t('admin.conceptLevel')} value={newConcept.level}
                onChange={e => setNewConcept({ ...newConcept, level: Number(e.target.value) })} style={{ marginBottom: '0.5rem' }} />

              <div style={{ marginBottom: '0.5rem' }}>
                <div style={{ fontSize: '0.8125rem', color: 'var(--text-light)', marginBottom: '0.25rem' }}>
                  {t('admin.prerequisites')}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem' }}>
                  {concepts.length === 0 && (
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-light)' }}>{t('admin.noPrerequisites')}</span>
                  )}
                  {concepts.map(concept => {
                    const picked = newConcept.prerequisites.includes(concept.id);
                    return (
                      <button
                        key={concept.id}
                        onClick={() => setNewConcept({
                          ...newConcept,
                          prerequisites: picked
                            ? newConcept.prerequisites.filter(id => id !== concept.id)
                            : [...newConcept.prerequisites, concept.id],
                        })}
                        style={{
                          padding: '0.2rem 0.5rem', borderRadius: '9999px', cursor: 'pointer',
                          border: '1px solid var(--border)', fontSize: '0.75rem',
                          background: picked ? 'var(--primary)' : 'transparent',
                          color: picked ? 'white' : 'var(--text)',
                        }}
                      >
                        {concept.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              <button className="btn btn-primary" style={{ width: '100%' }}
                onClick={async () => {
                  const saved = await post('/api/admin/curriculum/concepts', {
                    subjectId: current.id,
                    conceptId: newConcept.id,
                    name: newConcept.name,
                    level: newConcept.level,
                    prerequisites: newConcept.prerequisites,
                  });
                  if (saved) {
                    setNewConcept({ id: '', name: '', level: 1, prerequisites: [] });
                    loadConcepts(current.id);
                    loadSubjects();
                  }
                }}>
                {t('admin.create')}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
