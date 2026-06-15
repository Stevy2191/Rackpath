import React from 'react';
import { Navigate } from 'react-router-dom';
import { useProject } from '../project/ProjectContext';

// Smart landing page used for "/" and "/dashboard": sends the user straight
// to their project's dashboard when there's only one project, otherwise to
// the project selector (which also covers the "no projects yet" case).
export default function LandingRedirect() {
  const { projects, loading } = useProject();

  if (loading) return <div className="page-status">Loading...</div>;

  if (projects.length === 1) {
    return <Navigate to={`/projects/${projects[0].id}`} replace />;
  }

  return <Navigate to="/projects" replace />;
}
