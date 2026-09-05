import { useState } from 'react';
import { useAuth } from '../App';
import { useTranslation } from '../i18n';

interface Props {
  childId: number;
  subject: string;
  conceptId: string;
  onApplied?: () => void;
}

/**
 * Lets the adult overrule the engine about one concept. The reason field is
 * required by the API, not decoration: an override with no stated reason is
 * indistinguishable from a mistake when someone reads the log later.
 */
export default function ConceptOverride({ childId, subject, conceptId, onApplied }: Props) {
  const { token } = useAuth();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'done' | 'error'>('idle');

  async function apply(action: 'mark_mastered' | 'reset_concept') {
    if (reason.trim().length < 3) {
      setStatus('error');
      return;
    }

    setStatus('saving');
    try {
      const res = await fetch(`/api/parent/children/${childId}/override`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, subject, conceptId, reason }),
      });

      if (!res.ok) throw new Error('failed');

      setStatus('done');
      setReason('');
      onApplied?.();
    } catch {
      setStatus('error');
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          color: 'var(--primary)',
          fontSize: '0.75rem',
          cursor: 'pointer',
        }}
      >
        {t('override.title')}
      </button>
    );
  }

  return (
    <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <label style={{ fontSize: '0.75rem', color: 'var(--text-light)' }}>
        {t('override.reasonLabel')}
      </label>
      <input
        className="input"
        value={reason}
        onChange={e => { setReason(e.target.value); setStatus('idle'); }}
        placeholder={t('override.reasonPlaceholder')}
        style={{ fontSize: '0.8125rem' }}
      />

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <button
          onClick={() => apply('mark_mastered')}
          disabled={status === 'saving'}
          className="btn btn-outline"
          style={{ padding: '0.25rem 0.625rem', fontSize: '0.75rem' }}
        >
          {t('override.markMastered')}
        </button>
        <button
          onClick={() => apply('reset_concept')}
          disabled={status === 'saving'}
          className="btn btn-outline"
          style={{ padding: '0.25rem 0.625rem', fontSize: '0.75rem' }}
        >
          {t('override.reset')}
        </button>
      </div>

      {status === 'error' && (
        <span style={{ fontSize: '0.75rem', color: 'var(--error)' }}>
          {t('override.reasonRequired')}
        </span>
      )}
      {status === 'done' && (
        <span style={{ fontSize: '0.75rem', color: 'var(--success)' }}>{t('override.applied')}</span>
      )}
    </div>
  );
}
