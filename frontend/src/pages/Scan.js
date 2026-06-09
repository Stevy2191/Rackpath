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

  const loadJobs = () => {
    client.get('/scan').then((res) => setJobs(res.data)).catch((err) => setError(err.message));
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
        .get(`/scan/${selectedJob.id}`)
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

  const handleStartScan = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await client.post('/scan', { target_subnet: subnet });
      setSelectedJob(res.data);
      loadJobs();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

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
                  onClick={() => setSelectedJob(job)}
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
              {selectedJob.results && (
                <pre className="scan-json">{JSON.stringify(selectedJob.results, null, 2)}</pre>
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
