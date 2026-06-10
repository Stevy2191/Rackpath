import React, { useEffect, useState } from 'react';
import client from '../api/client';
import './Scan.css';

const ACTIVE_STATUSES = ['pending', 'running'];

export default function ScanPage() {
  const [subnet, setSubnet] = useState('192.168.1.0/24');
  const [jobs, setJobs] = useState([]);
  const [selectedJob, setSelectedJob] = useState(null);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [selectedDevices, setSelectedDevices] = useState(new Set());
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState(null);

  const loadJobs = () => {
    client.get('/scans').then((res) => setJobs(res.data)).catch((err) => setError(err.message));
  };

  useEffect(() => {
    loadJobs();
    const interval = setInterval(loadJobs, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!selectedJob || !ACTIVE_STATUSES.includes(selectedJob.status)) return undefined;

    const interval = setInterval(() => {
      client
        .get(`/scans/${selectedJob.id}`)
        .then((res) => {
          setSelectedJob(res.data);
          if (!ACTIVE_STATUSES.includes(res.data.status)) {
            loadJobs();
          }
        })
        .catch((err) => setError(err.message));
    }, 3000);

    return () => clearInterval(interval);
  }, [selectedJob]);

  const handleSelectJob = (job) => {
    setSelectedJob(job);
    setSelectedDevices(new Set());
    setImportMessage(null);
  };

  const handleStartScan = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await client.post('/scans', { target_subnet: subnet });
      handleSelectJob(res.data);
      loadJobs();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const toggleDeviceSelection = (index) => {
    setSelectedDevices((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const toggleSelectAll = (discoveredDevices) => {
    setSelectedDevices((prev) =>
      prev.size === discoveredDevices.length ? new Set() : new Set(discoveredDevices.map((_, i) => i))
    );
  };

  const handleImportSelected = async (discoveredDevices) => {
    const devices = discoveredDevices.filter((_, i) => selectedDevices.has(i));
    if (devices.length === 0) return;

    setImporting(true);
    setImportMessage(null);
    try {
      const res = await client.post(`/scans/${selectedJob.id}/import`, { devices });
      setImportMessage(`Added ${res.data.device_ids.length} device(s) to inventory.`);
      setSelectedDevices(new Set());
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(false);
    }
  };

  const discoveredDevices = selectedJob?.results?.devices || [];
  const hasProgress = selectedJob?.progress_total != null && selectedJob.progress_total > 0;
  const progressPercent = hasProgress
    ? Math.min(100, Math.round(((selectedJob.progress_current || 0) / selectedJob.progress_total) * 100))
    : 0;

  return (
    <div className="scan-page">
      {error && <div className="page-error">{error}</div>}

      <form onSubmit={handleStartScan} className="scan-form">
        <h2>Start a Scan</h2>
        <input
          value={subnet}
          onChange={(e) => setSubnet(e.target.value)}
          placeholder="e.g. 192.168.1.0/24"
          required
        />
        <button type="submit" disabled={submitting}>
          {submitting ? 'Starting...' : 'Start Scan'}
        </button>
      </form>

      <div className="scan-body">
        <aside className="scan-jobs">
          <h3>Scan Jobs</h3>
          <ul>
            {jobs.map((job) => (
              <li key={job.id}>
                <button
                  className={selectedJob?.id === job.id ? 'active' : ''}
                  onClick={() => handleSelectJob(job)}
                >
                  #{job.id} {job.target_subnet} &mdash; {job.status}
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className="scan-results">
          {selectedJob ? (
            <>
              <h3>
                Job #{selectedJob.id} &mdash; {selectedJob.status}
              </h3>
              <p>Subnet: {selectedJob.target_subnet}</p>
              <p>Started: {selectedJob.started_at || '-'}</p>
              <p>Completed: {selectedJob.completed_at || '-'}</p>

              {ACTIVE_STATUSES.includes(selectedJob.status) && (
                <div className="scan-progress">
                  <div className="scan-progress-bar">
                    <div className="scan-progress-fill" style={{ width: `${hasProgress ? progressPercent : 0}%` }} />
                  </div>
                  <div className="scan-progress-label">
                    {hasProgress
                      ? `Scanned ${selectedJob.progress_current} of ${selectedJob.progress_total} hosts (${progressPercent}%)`
                      : 'Scanning...'}
                  </div>
                </div>
              )}

              {discoveredDevices.length > 0 && (
                <div className="scan-devices">
                  <h3>Discovered Devices</h3>
                  <p className="scan-devices-status">
                    Select the devices you want to add to your inventory. Nothing is added automatically.
                  </p>
                  <div className="scan-devices-actions">
                    <button type="button" onClick={() => toggleSelectAll(discoveredDevices)}>
                      {selectedDevices.size === discoveredDevices.length ? 'Deselect All' : 'Select All'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleImportSelected(discoveredDevices)}
                      disabled={importing || selectedDevices.size === 0}
                    >
                      {importing ? 'Adding...' : `Add Selected (${selectedDevices.size})`}
                    </button>
                    {importMessage && <span className="scan-devices-status">{importMessage}</span>}
                  </div>
                  <table className="scan-device-table">
                    <thead>
                      <tr>
                        <th></th>
                        <th>Hostname</th>
                        <th>IP</th>
                        <th>MAC</th>
                        <th>Type</th>
                        <th>Description</th>
                      </tr>
                    </thead>
                    <tbody>
                      {discoveredDevices.map((device, index) => (
                        <tr key={`${device.ip || device.mac || index}`}>
                          <td>
                            <input
                              type="checkbox"
                              checked={selectedDevices.has(index)}
                              onChange={() => toggleDeviceSelection(index)}
                            />
                          </td>
                          <td>{device.hostname || '-'}</td>
                          <td>{device.ip || '-'}</td>
                          <td>{device.mac || '-'}</td>
                          <td>{device.type || '-'}</td>
                          <td>{device.snmp_descr || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {selectedJob.results && (
                <details className="scan-raw-results">
                  <summary>Raw scan results</summary>
                  <pre className="scan-json">{JSON.stringify(selectedJob.results, null, 2)}</pre>
                </details>
              )}
            </>
          ) : (
            <div className="page-status">Select a scan job to view details.</div>
          )}
        </section>
      </div>
    </div>
  );
}
