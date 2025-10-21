ALTER TABLE `users` ADD `nickname` varchar(64);--> statement-breakpoint
-- commenting this out for now as it's destructive and we may need to roll-back this release
-- ALTER TABLE `users` DROP COLUMN `avatar`;
