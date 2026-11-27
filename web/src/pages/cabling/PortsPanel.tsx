// Ports of a device or a rack with everything you can do to them: add,
// edit, connect, change or remove cables, trace.
import { useState } from 'react';
import { ListPlus, Plus, X } from 'lucide-react';
import { api } from '../../api';
import type { ListedPort } from '../../types';
import { Button, Card, ErrorBox, FormModal, Spinner, useLoad, useToast } from '../../ui';
import { CableEdit, ConnectForm } from './Connect';
import { BulkPortsForm, PortForm } from './PortForm';
import { PortsTable } from './PortsTable';
import { TraceView } from './Trace';

type Modal =
  | { t: 'add' }
  | { t: 'bulk' }
  | { t: 'edit'; p: ListedPort }
  | { t: 'delete'; p: ListedPort }
  | { t: 'connect'; p: ListedPort; side: 'front' | 'rear' }
  | { t: 'cable'; id: number };

export function PortsPanel({
  projectId,
  deviceId,
  rackId,
  canEdit,
  groupBy,
}: {
  projectId: number;
  deviceId?: number;
  rackId?: number;
  canEdit: boolean;
  groupBy?: (p: ListedPort) => string;
}) {
  const url = deviceId ? `/api/devices/${deviceId}/ports` : `/api/racks/${rackId}/ports`;
  const ports = useLoad(() => api.get<{ ports: ListedPort[] }>(url).then((r) => r.ports.filter((p) => p.medium !== 'power')), [url]);
  const [modal, setModal] = useState<Modal | null>(null);
  const [tracing, setTracing] = useState<ListedPort | null>(null);
  const [version, setVersion] = useState(0);
  const toast = useToast();
  const reload = () => {
    setVersion((v) => v + 1);
    return ports.reload();
  };
  const close = () => setModal(null);
  return (
    <div className="stack">
      {deviceId && canEdit && (
        <div className="row">
          <Button icon={<Plus size={15} />} onClick={() => setModal({ t: 'add' })}>Add port</Button>
          <Button icon={<ListPlus size={15} />} onClick={() => setModal({ t: 'bulk' })}>Add numbered ports</Button>
        </div>
      )}
      <ErrorBox error={ports.error} onRetry={ports.reload} />
      {!ports.data ? (
        <Spinner />
      ) : (
        <PortsTable
          ports={ports.data}
          projectId={projectId}
          groupBy={groupBy}
          selected={tracing?.id}
          actions={{
            onTrace: setTracing,
            onConnect: canEdit ? (p, side) => setModal({ t: 'connect', p, side }) : undefined,
            onCable: canEdit ? (id) => setModal({ t: 'cable', id }) : undefined,
            onEdit: canEdit && deviceId ? (p) => setModal({ t: 'edit', p }) : undefined,
          }}
        />
      )}
      {tracing && (
        <Card
          title={`Trace from ${tracing.path.split('/').slice(-2).join(' ')}`}
          actions={<Button variant="ghost" icon={<X size={15} />} aria-label="Close trace" onClick={() => setTracing(null)} />}
        >
          <TraceView portId={tracing.id} projectId={projectId} canEdit={canEdit} version={version} onChanged={reload} />
        </Card>
      )}
      {modal?.t === 'add' && deviceId && <PortForm deviceId={deviceId} onClose={close} onSaved={reload} />}
      {modal?.t === 'bulk' && deviceId && <BulkPortsForm deviceId={deviceId} onClose={close} onSaved={(n) => { toast.ok(`Added ${n} ports`); reload(); }} />}
      {modal?.t === 'edit' && deviceId && (
        <PortForm deviceId={deviceId} existing={modal.p} onClose={close} onSaved={reload} onDelete={() => setModal({ t: 'delete', p: modal.p })} />
      )}
      {modal?.t === 'delete' && (
        <FormModal
          title={`Delete port ${modal.p.code}`}
          submitLabel="Delete"
          danger
          onClose={close}
          onSubmit={async () => {
            await api.del(`/api/ports/${modal.p.id}`);
            if (tracing?.id === modal.p.id) setTracing(null);
            reload();
          }}
        >
          <p>{modal.p.front || modal.p.rear ? 'Its cables are removed too.' : 'It has no cables.'}</p>
        </FormModal>
      )}
      {modal?.t === 'connect' && (
        <ConnectForm
          projectId={projectId}
          from={modal.p}
          side={modal.side}
          onClose={close}
          onSaved={() => {
            setTracing(modal.p);
            reload();
          }}
        />
      )}
      {modal?.t === 'cable' && <CableEdit id={modal.id} onClose={close} onSaved={reload} />}
    </div>
  );
}
