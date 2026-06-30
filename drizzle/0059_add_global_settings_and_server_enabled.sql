ALTER TABLE `servers` ADD COLUMN `enabled` boolean NOT NULL DEFAULT true;

CREATE TABLE `globalSettings` (
  `id` int PRIMARY KEY DEFAULT 1,
  `settings` json NOT NULL DEFAULT ('{}')
);
