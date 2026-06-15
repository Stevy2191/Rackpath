-- Recent-activity feed for the Site Overview Dashboard: a log of
-- create/update/delete actions performed on project-scoped resources.
CREATE TABLE IF NOT EXISTS project_activity_log (
    id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    project_id  INT UNSIGNED NOT NULL,
    user_id     INT UNSIGNED NOT NULL,
    action      VARCHAR(100) NOT NULL,
    details     VARCHAR(255) NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_project_activity_log_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_project_activity_log_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    KEY idx_project_activity_log_project (project_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
