// A port's chain, end to end: ports and the cables between them.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Cable, Palette } from 'lucide-react';
import { api } from '../../api';
import { link } from '../../links';
import type { ChainState, Trace } from '../../types';
import { Badge, Button, ErrorBox, Spinner, Warnings, message, useLoad } from '../../ui';

export const stateTone = (s: ChainState) => (s === 'complete' ? 'ok' : s === 'incomplete' ? 'warn' : 'neutral');
export const stateText = (s: ChainState) => (s === 'complete' ? 'Complete' : s === 'incomplete' ? 'Incomplete' : 'Not connected');

const short = (path: string | null) => (path ? path.split('/').slice(-2).join(' ') : '?');

export function TraceView({ portId, projectId, canEdit, version = 0, onChanged }: { portId: number; projectId: number; canEdit?: boolean; version?: number; onChanged?: () => void }) {
  const trace = useLoad(() => api.get<Trace>(`/api/ports/${portId}/trace`), [portId, version]);
  const [color, setColor] = useState('#1e90ff');
  const [err, setErr] = useState<string | null>(null);
  if (trace.error) return <ErrorBox error={trace.error} onRetry={trace.reload} />;
  if (!trace.data) return <Spinner />;
  const t = trace.data;
  const hasPatch = t.hops.some((h) => h.type === 'cable' && h.kind === 'patch');
  return (
    <div className="trace stack">
      <div className="row">
        <Badge tone={stateTone(t.state)}>{stateText(t.state)}</Badge>
        {t.total_length_m != null && <span className="small muted">{t.total_length_m} m in total</span>}
        {t.truncated && <Badge tone="warn">Stopped after 64 hops</Badge>}
      </div>
      <ol className="trace-hops" aria-label="Chain">
        {t.hops.map((h, i) =>
          h.type === 'port' ? (
            <li key={`p${h.id}-${i}`} className={`trace-port${h.id === portId ? ' here' : ''}`}>
              <Link to={link.port(projectId, h.id)} className="mono">{short(h.path)}</Link>
              <span className="small muted">
                {[h.role === 'passive' ? 'passive' : null, h.transceiver ?? h.connector, h.enter && h.exit ? `${h.enter} → ${h.exit}` : (h.enter ?? h.exit)].filter(Boolean).join(' · ')}
              </span>
            </li>
          ) : (
            <li key={`c${h.id}`} className="trace-cable" style={h.color ? { borderColor: h.color } : undefined}>
              <Cable size={14} />
              <span className="small">
                {[h.kind === 'permanent' ? 'Permanent' : h.kind === 'power' ? 'Power cord' : 'Patch', h.cable_type, h.length_m != null ? `${h.length_m} m` : null, h.label].filter(Boolean).join(' · ')}
              </span>
            </li>
          ),
        )}
      </ol>
      <Warnings items={t.warnings} />
      {canEdit && hasPatch && (
        <div className="row">
          <input type="color" aria-label="Chain colour" value={color} onChange={(e) => setColor(e.target.value)} />
          <Button
            variant="ghost"
            icon={<Palette size={15} />}
            onClick={async () => {
              try {
                await api.post(`/api/ports/${portId}/chain-color`, { color });
                setErr(null);
                trace.reload();
                onChanged?.();
              } catch (e) {
                setErr(message(e));
              }
            }}
          >
            Colour the patch cords
          </Button>
        </div>
      )}
      <ErrorBox error={err} />
    </div>
  );
}
