ALTER TABLE `matchHistory` DROP INDEX `matchHistory_ordinal_unique`;--> statement-breakpoint
ALTER TABLE `matchHistory` ADD `serverId` varchar(256);--> statement-breakpoint
UPDATE `matchHistory` SET `serverId` = (SELECT `id` FROM `servers` ORDER BY `id` LIMIT 1) WHERE `serverId` IS NULL;--> statement-breakpoint
ALTER TABLE `matchHistory` MODIFY `serverId` varchar(256) NOT NULL;--> statement-breakpoint
ALTER TABLE `matchHistory` ADD CONSTRAINT `serverOrdinalUnique` UNIQUE(`serverId`,`ordinal`);--> statement-breakpoint
ALTER TABLE `matchHistory` ADD CONSTRAINT `matchHistory_serverId_servers_id_fk` FOREIGN KEY (`serverId`) REFERENCES `servers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `matchHistory` DROP COLUMN `layerVote`;
