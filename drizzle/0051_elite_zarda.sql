ALTER TABLE `playerEventAssociations` DROP FOREIGN KEY `playerEventAssociations_playerId_players_steamId_fk`;--> statement-breakpoint
ALTER TABLE `squads` DROP FOREIGN KEY `squads_creatorId_players_steamId_fk`;--> statement-breakpoint
ALTER TABLE `players` DROP INDEX `players_eosId_unique`;--> statement-breakpoint
ALTER TABLE `players` DROP PRIMARY KEY;--> statement-breakpoint
ALTER TABLE `players` MODIFY COLUMN `steamId` bigint;--> statement-breakpoint
ALTER TABLE `players` ADD PRIMARY KEY(`eosId`);--> statement-breakpoint
ALTER TABLE `players` ADD CONSTRAINT `players_steamId_unique` UNIQUE(`steamId`);
