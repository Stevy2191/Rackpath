CREATE TABLE IF NOT EXISTS topology_zones (
    id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name            VARCHAR(255)            NOT NULL,
    border_style    ENUM('solid', 'dotted') NOT NULL DEFAULT 'solid',
    color           VARCHAR(32)             NOT NULL DEFAULT 'blue',
    x               DOUBLE                  NOT NULL DEFAULT 0,
    y               DOUBLE                  NOT NULL DEFAULT 0,
    width           DOUBLE                  NOT NULL DEFAULT 300,
    height          DOUBLE                  NOT NULL DEFAULT 200,
    created_at      TIMESTAMP               NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
