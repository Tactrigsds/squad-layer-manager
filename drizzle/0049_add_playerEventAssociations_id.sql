ALTER TABLE `playerEventAssociations` DROP FOREIGN KEY `playerEventAssociations_serverEventId_serverEvents_id_fk`;--> statement-breakpoint
ALTER TABLE `playerEventAssociations` DROP FOREIGN KEY `playerEventAssociations_playerId_players_steamId_fk`;--> statement-breakpoint
ALTER TABLE `playerEventAssociations` DROP PRIMARY KEY;--> statement-breakpoint
ALTER TABLE `playerEventAssociations` ADD `id` int AUTO_INCREMENT NOT NULL PRIMARY KEY FIRST;--> statement-breakpoint
ALTER TABLE `playerEventAssociations` ADD CONSTRAINT `playerEventAssociations_serverEventId_serverEvents_id_fk` FOREIGN KEY (`serverEventId`) REFERENCES `serverEvents`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `playerEventAssociations` ADD CONSTRAINT `playerEventAssociations_playerId_players_steamId_fk` FOREIGN KEY (`playerId`) REFERENCES `players`(`steamId`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `assocTypeIndex` ON `playerEventAssociations` (`assocType`);--> statement-breakpoint
CREATE INDEX `serverEventIdIndex` ON `playerEventAssociations` (`serverEventId`);
