CREATE TABLE `playerEventAssociations` (
	`serverEventId` int NOT NULL,
	`playerId` bigint NOT NULL,
	`assocType` enum('player','attacker','victim','game-participant') NOT NULL,
	`createdAt` timestamp DEFAULT (now()),
	CONSTRAINT `playerEventAssociations_serverEventId_playerId_pk` PRIMARY KEY(`serverEventId`,`playerId`)
);
--> statement-breakpoint
CREATE TABLE `players` (
	`steamId` bigint NOT NULL,
	`eosId` varchar(32) NOT NULL,
	`username` varchar(48) NOT NULL,
	`usernameNoTag` varchar(32),
	`createdAt` timestamp DEFAULT (now()),
	`modifiedAt` timestamp DEFAULT (now()),
	CONSTRAINT `players_steamId` PRIMARY KEY(`steamId`),
	CONSTRAINT `players_eosId_unique` UNIQUE(`eosId`)
);
--> statement-breakpoint
CREATE TABLE `squadEventAssociations` (
	`serverEventId` int NOT NULL,
	`squadId` int NOT NULL,
	`createdAt` timestamp DEFAULT (now()),
	CONSTRAINT `squadEventAssociations_serverEventId_squadId_pk` PRIMARY KEY(`serverEventId`,`squadId`)
);
--> statement-breakpoint
CREATE TABLE `squads` (
	`id` int NOT NULL,
	`ingameSquadId` int NOT NULL,
	`name` varchar(64) NOT NULL,
	`creatorId` bigint,
	`createdAt` timestamp DEFAULT (now()),
	CONSTRAINT `squads_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `serverEvents` MODIFY COLUMN `id` int AUTO_INCREMENT NOT NULL;--> statement-breakpoint
ALTER TABLE `playerEventAssociations` ADD CONSTRAINT `playerEventAssociations_serverEventId_serverEvents_id_fk` FOREIGN KEY (`serverEventId`) REFERENCES `serverEvents`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `playerEventAssociations` ADD CONSTRAINT `playerEventAssociations_playerId_players_steamId_fk` FOREIGN KEY (`playerId`) REFERENCES `players`(`steamId`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `squadEventAssociations` ADD CONSTRAINT `squadEventAssociations_serverEventId_serverEvents_id_fk` FOREIGN KEY (`serverEventId`) REFERENCES `serverEvents`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `squadEventAssociations` ADD CONSTRAINT `squadEventAssociations_squadId_squads_id_fk` FOREIGN KEY (`squadId`) REFERENCES `squads`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `squads` ADD CONSTRAINT `squads_creatorId_players_steamId_fk` FOREIGN KEY (`creatorId`) REFERENCES `players`(`steamId`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `playerIdIndex` ON `playerEventAssociations` (`playerId`);--> statement-breakpoint
CREATE INDEX `eosIdIndex` ON `players` (`eosId`);--> statement-breakpoint
CREATE INDEX `usernameIndex` ON `players` (`username`);--> statement-breakpoint
CREATE INDEX `createdAtIndex` ON `players` (`createdAt`);--> statement-breakpoint
CREATE INDEX `nameIndex` ON `squads` (`name`);--> statement-breakpoint
CREATE INDEX `creatorIdIndex` ON `squads` (`creatorId`);--> statement-breakpoint
CREATE INDEX `typeIndex` ON `serverEvents` (`type`);--> statement-breakpoint
CREATE INDEX `timeIndex` ON `serverEvents` (`time`);--> statement-breakpoint
CREATE INDEX `matchIdIndex` ON `serverEvents` (`matchId`);