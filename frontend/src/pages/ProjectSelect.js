import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useProject } from '../project/ProjectContext';
import client from '../api/client';
import TemplatePicker from '../components/TemplatePicker';
import './ProjectSelect.css';

export default function ProjectSelectPage() {
  const { projects, loading, switchProject, createProject } = useProject();
  const navigate = useNavigate();
  const [step, setStep] = useState('details'); // 'details' | 'template'
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [template, setTemplate] = useState('blank');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  if (loading) return <div className="page-status">Loading...</div>;

  const selectProject = (project) => {
    switchProject(project.id);
    navigate(`/projects/${project.id}`);
  };

  const handleContinue = (e) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    setError(null);
    setStep('template');
  };

  const handleBack = () => {
    setStep('details');
    setError(null);
  };

  const finishCreate = async (templateKey) => {
    setSaving(true);
    setError(null);
    try {
      const project = await createProject({ name: name.trim(), description: description.trim() || null });
      if (templateKey !== 'blank') {
        await client.post(`/projects/${project.id}/apply-template`, { template: templateKey });
      }
      navigate(`/projects/${project.id}`);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
      setSaving(false);
    }
  };

  return (
    <div className="project-select-page">
      {projects.length > 0 && (
        <div className="project-select-section">
          <h2>Select a Project</h2>
          <div className="project-select-list">
            {projects.map((project) => (
              <button key={project.id} type="button" className="project-select-card" onClick={() => selectProject(project)}>
                <span className="project-select-name">{project.name}</span>
                {project.description && <span className="project-select-description">{project.description}</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="project-select-section">
        {step === 'details' ? (
          <>
            <h2>{projects.length === 0 ? 'Create your first project' : 'Create a new project'}</h2>
            <form className="project-select-form" onSubmit={handleContinue}>
              <label>
                Name
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name" autoFocus />
              </label>
              <label>
                Description (optional)
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What is this project for?"
                  rows={3}
                />
              </label>
              {error && <div className="page-error">{error}</div>}
              <button type="submit">Continue</button>
            </form>
          </>
        ) : (
          <>
            <h2>Choose a starting template</h2>
            <TemplatePicker value={template} onChange={setTemplate} />
            {error && <div className="page-error">{error}</div>}
            <div className="project-select-template-actions">
              <button type="button" className="project-select-link" onClick={handleBack} disabled={saving}>
                Back
              </button>
              <button
                type="button"
                className="project-select-link"
                onClick={() => finishCreate('blank')}
                disabled={saving}
              >
                Start blank
              </button>
              <button type="button" onClick={() => finishCreate(template)} disabled={saving}>
                {saving ? 'Creating...' : 'Create Project'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
