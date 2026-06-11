import axios from 'axios';

export const PROJECT_STORAGE_KEY = 'rackpath_project_id';

const client = axios.create({
  baseURL: process.env.REACT_APP_API_BASE_URL || '/api',
  // Send the httpOnly session cookie with every request.
  withCredentials: true,
});

let onUnauthorized = null;

// Current project id sent as X-Project-ID on every request. Seeded from
// localStorage so the very first data fetch already targets the right project.
let projectId = null;
try {
  projectId = localStorage.getItem(PROJECT_STORAGE_KEY) || null;
} catch (err) {
  projectId = null;
}

export function setProjectId(id) {
  projectId = id != null ? String(id) : null;
}

export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler;
}

// Attach the current project id (defaulting to the Default Project) to every request.
client.interceptors.request.use((config) => {
  config.headers['X-Project-ID'] = projectId || '1';
  return config;
});

client.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401 && onUnauthorized) {
      onUnauthorized();
    }
    return Promise.reject(error);
  }
);

export default client;
