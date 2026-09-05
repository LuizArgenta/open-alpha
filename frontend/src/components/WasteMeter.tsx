export interface FocusReason {
  code: 'rapid_guessing' | 'walked_away' | 'low_accuracy';
  detail: string;
  points: number;
  contestable: boolean;
  contested: boolean;
}

interface Props {
  focusScore: number;
  reasons: FocusReason[];
  onContest: (code: FocusReason['code']) => void;
}

const CONTEST_LABELS: Record<FocusReason['code'], string> = {
  rapid_guessing: "I wasn't guessing",
  walked_away: 'I was still working',
  low_accuracy: '',
};

export default function WasteMeter({ focusScore, reasons, onContest }: Props) {
  // Color gradient from green (focused) to red (waste)
  const getColor = (focus: number) => {
    if (focus >= 80) return 'var(--success)';
    if (focus >= 60) return '#f59e0b'; // amber
    return 'var(--error)';
  };

  const color = getColor(focusScore);
  const label = focusScore >= 80 ? 'Locked In' : focusScore >= 60 ? 'Stay Focused' : 'Too Much Waste';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontWeight: 600, fontSize: '0.9375rem' }}>Focus Meter</span>
        <span style={{ fontSize: '0.8125rem', fontWeight: 600, color }}>{label}</span>
      </div>

      {/* Main bar */}
      <div style={{ height: '10px', background: 'var(--border)', borderRadius: '5px', overflow: 'hidden', position: 'relative' }}>
        <div style={{
          height: '100%',
          width: `${focusScore}%`,
          background: color,
          borderRadius: '5px',
          transition: 'width 0.5s ease, background 0.3s ease',
        }} />
      </div>

      {/* Why the score looks like this, and a way to disagree with it */}
      {reasons.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: '0.25rem 0 0', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {reasons.map((reason) => (
            <li
              key={reason.code}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '0.5rem',
                fontSize: '0.75rem',
                color: 'var(--text-light)',
                flexWrap: 'wrap',
              }}
            >
              <span style={{ textDecoration: reason.contested ? 'line-through' : 'none' }}>
                {reason.detail}
                {reason.points > 0 && ` (−${reason.points})`}
              </span>

              {reason.contested ? (
                <span style={{ fontStyle: 'italic', flexShrink: 0 }}>not counted today</span>
              ) : reason.contestable ? (
                <button
                  onClick={() => onContest(reason.code)}
                  style={{
                    background: 'none',
                    border: '1px solid var(--border)',
                    borderRadius: '9999px',
                    padding: '0.125rem 0.5rem',
                    fontSize: '0.7rem',
                    color: 'var(--primary)',
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                >
                  {CONTEST_LABELS[reason.code]}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
