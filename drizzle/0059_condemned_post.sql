CREATE TABLE `globalSettings` (
	`id` int NOT NULL DEFAULT 1,
	`settings` json NOT NULL DEFAULT ('{"json":{}}'),
	CONSTRAINT `globalSettings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `servers` ADD `enabled` boolean DEFAULT true NOT NULL;