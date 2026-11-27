// Ports with both cable sides, VLANs and chain state: on a device page and
// in a rack's patching view.
import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import { Pencil, Plug, Route } from 'lucide-react';
import { link } from '../../links';
import type { CableOnPort, ListedPort } from '../../types';
import { Badge, Empty } from '../../ui';
import { freeSides } from './Connect';
import { speedText } from './media';
import { stateText, stateTone } from './Trace';

export interface PortActions {
  onConnect?: (p: ListedPort, side: 'front' | 'rear') => void;
  onCable?: (connectionId: number) => void;
  onEdit?: (p: ListedPort) => void;
  onTrace?: (p: ListedPort) => void;
}

function CableCell({ c, p, side, projectId, a }: { c: CableOnPort | null; p: ListedPort; side: 'front' | 'rear'; projectId: number; a: PortActions }) {
  if (c) {
    return (
      <span className="cable-cell">
        <span className="swatch" style={{ background: c.color ?? 'var(--color-border-strong)' }} />
        <Link to={link.port(projectId, c.far.port_id)} className="mono">{c.far.path.split('/').slice(-2).join(' ')}</Link>
        <span className="small muted">{[c.cable_type, c.length_m != null ? `${c.length_m} m` : null].filter(Boolean).join(' · ')}</span>
        {a.onCable && (
          <button type="button" className="icon-btn" aria-label={`Cable on ${p.code} ${side}`} onClick={() => a.onCable!(c.connection_id)}>
            <Pencil size={13} />
          </button>
        )}
      </span>
    );
  }
  if (a.onConnect && freeSides(p).includes(side)) {
    return (
      <button type="button" className="link-btn" onClick={() => a.onConnect!(p, side)} aria-label={`Connect ${p.code} ${side}`}>
        <Plug size={13} /> Connect
      </button>
    );
  }
  return <span className="muted">—</span>;
}

export function PortsTable({
  ports,
  projectId,
  actions,
  groupBy,
  selected,
}: {
  ports: ListedPort[];
  projectId: number;
  actions: PortActions;
  /** Show a heading row per device (rack view): device id → label. */
  groupBy?: (p: ListedPort) => string;
  selected?: number | null;
}) {
  if (ports.length === 0) return <Empty title="No ports yet" />;
  const anyPassive = ports.some((p) => p.role === 'passive');
  let last = '';
  return (
    <div className="table-wrap">
      <table className="table ports">
        <thead>
          <tr>
            <th>Port</th>
            <th>Media</th>
            <th>{anyPassive ? 'Front' : 'Cable'}</th>
            {anyPassive && <th>Rear</th>}
            <th>VLANs</th>
            <th>Chain</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {ports.map((p) => {
            const group = groupBy?.(p);
            const head = group !== undefined && group !== last;
            last = group ?? last;
            return (
              <Fragment key={p.id}>
                {head && (
                  <tr className="group-row">
                    <td colSpan={anyPassive ? 7 : 6}>{group}</td>
                  </tr>
                )}
                <tr className={selected === p.id ? 'selected' : undefined} data-port={p.code}>
                  <td>
                    <Link to={link.port(projectId, p.id)} className="mono">{p.code}</Link>
                    {p.interface_name && <div className="small muted">{p.interface_name}</div>}
                  </td>
                  <td className="small">
                    {[p.transceiver ?? p.connector, speedText(p.effective_speed), p.poe ? `PoE ${p.poe}` : null, p.role === 'passive' ? 'passive' : null].filter(Boolean).join(' · ')}
                  </td>
                  <td><CableCell c={p.front} p={p} side="front" projectId={projectId} a={actions} /></td>
                  {anyPassive && <td>{p.role === 'passive' ? <CableCell c={p.rear} p={p} side="rear" projectId={projectId} a={actions} /> : <span className="muted">—</span>}</td>}
                  <td className="small">
                    {p.vlans.map((v) => (
                      <span key={v.id} className={v.mode === 'tagged' ? 'muted' : undefined}>{v.vid}{v.mode === 'tagged' ? 't' : ''} </span>
                    ))}
                  </td>
                  <td><Badge tone={stateTone(p.chain_state)}>{stateText(p.chain_state)}</Badge></td>
                  <td className="row-actions">
                    {actions.onTrace && p.chain_state !== 'unconnected' && (
                      <button type="button" className="icon-btn" aria-label={`Trace ${p.code}`} onClick={() => actions.onTrace!(p)}>
                        <Route size={15} />
                      </button>
                    )}
                    {actions.onEdit && (
                      <button type="button" className="icon-btn" aria-label={`Edit port ${p.code}`} onClick={() => actions.onEdit!(p)}>
                        <Pencil size={15} />
                      </button>
                    )}
                  </td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
