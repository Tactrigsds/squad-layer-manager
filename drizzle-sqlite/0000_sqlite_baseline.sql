CREATE TABLE `balanceTriggerEvents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`triggerId` text NOT NULL,
	`triggerVersion` integer NOT NULL,
	`matchTriggeredId` integer,
	`strongerTeam` text NOT NULL,
	`level` text NOT NULL,
	`evaluationResult` text NOT NULL,
	FOREIGN KEY (`matchTriggeredId`) REFERENCES `matchHistory`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `filterRoleContributors` (
	`filterId` text NOT NULL,
	`roleId` text NOT NULL,
	PRIMARY KEY(`filterId`, `roleId`),
	FOREIGN KEY (`filterId`) REFERENCES `filters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `filterUserContributors` (
	`filterId` text NOT NULL,
	`userId` text NOT NULL,
	PRIMARY KEY(`filterId`, `userId`),
	FOREIGN KEY (`filterId`) REFERENCES `filters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `users`(`discordId`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `filters` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`filter` text NOT NULL,
	`owner` text,
	`alertMessage` text,
	`emoji` text,
	`invertedAlertMessage` text,
	`invertedEmoji` text,
	FOREIGN KEY (`owner`) REFERENCES `users`(`discordId`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `filters_emoji_unique` ON `filters` (`emoji`);--> statement-breakpoint
CREATE TABLE `globalSettings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`settings` text DEFAULT '{"json":{}}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `matchHistory` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`serverId` text NOT NULL,
	`ordinal` integer NOT NULL,
	`layerId` text NOT NULL,
	`rawLayerCommandText` text,
	`lqItemId` text,
	`startTime` integer,
	`endTime` integer,
	`createdAt` integer,
	`outcome` text,
	`team1Tickets` integer,
	`team2Tickets` integer,
	`setByType` text NOT NULL,
	`setByUserId` text,
	FOREIGN KEY (`serverId`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `layerIdIndex` ON `matchHistory` (`layerId`);--> statement-breakpoint
CREATE INDEX `startTimeIndex` ON `matchHistory` (`startTime`);--> statement-breakpoint
CREATE INDEX `endTimeIndex` ON `matchHistory` (`endTime`);--> statement-breakpoint
CREATE INDEX `userIndex` ON `matchHistory` (`setByUserId`);--> statement-breakpoint
CREATE UNIQUE INDEX `serverOrdinalUnique` ON `matchHistory` (`serverId`,`ordinal`);--> statement-breakpoint
CREATE TABLE `persistedCache` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `persistedCacheUpdatedAtIndex` ON `persistedCache` (`updatedAt`);--> statement-breakpoint
CREATE TABLE `playerEventAssociations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`serverEventId` integer NOT NULL,
	`playerId` text NOT NULL,
	`assocType` text NOT NULL,
	`createdAt` integer,
	FOREIGN KEY (`serverEventId`) REFERENCES `serverEvents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`playerId`) REFERENCES `players`(`eosId`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `playerIdIndex` ON `playerEventAssociations` (`playerId`);--> statement-breakpoint
CREATE INDEX `assocTypeIndex` ON `playerEventAssociations` (`assocType`);--> statement-breakpoint
CREATE INDEX `serverEventIdIndex` ON `playerEventAssociations` (`serverEventId`);--> statement-breakpoint
CREATE UNIQUE INDEX `serverEventPlayerAssocUnique` ON `playerEventAssociations` (`serverEventId`,`playerId`,`assocType`);--> statement-breakpoint
CREATE TABLE `players` (
	`eosId` text PRIMARY KEY NOT NULL,
	`steamId` text,
	`epicId` text,
	`username` text NOT NULL,
	`usernameNoTag` text,
	`createdAt` integer,
	`modifiedAt` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `players_steamId_unique` ON `players` (`steamId`);--> statement-breakpoint
CREATE UNIQUE INDEX `players_epicId_unique` ON `players` (`epicId`);--> statement-breakpoint
CREATE INDEX `eosIdIndex` ON `players` (`eosId`);--> statement-breakpoint
CREATE INDEX `usernameIndex` ON `players` (`username`);--> statement-breakpoint
CREATE INDEX `createdAtIndex` ON `players` (`createdAt`);--> statement-breakpoint
CREATE TABLE `serverEvents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`time` integer NOT NULL,
	`matchId` integer NOT NULL,
	`version` integer DEFAULT 1,
	`data` text NOT NULL,
	FOREIGN KEY (`matchId`) REFERENCES `matchHistory`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `typeIndex` ON `serverEvents` (`type`);--> statement-breakpoint
CREATE INDEX `timeIndex` ON `serverEvents` (`time`);--> statement-breakpoint
CREATE INDEX `matchIdIndex` ON `serverEvents` (`matchId`);--> statement-breakpoint
CREATE TABLE `servers` (
	`id` text PRIMARY KEY NOT NULL,
	`displayName` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`defaultServer` integer DEFAULT false NOT NULL,
	`layerQueue` text DEFAULT '{"json":[]}' NOT NULL,
	`teamswitches` text DEFAULT '{"json":[],"meta":{"values":["map"],"v":1}}' NOT NULL,
	`settings` text DEFAULT '{"json":{}}'
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`session` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`expiresAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`discordId`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `expiresAtIndex` ON `sessions` (`expiresAt`);--> statement-breakpoint
CREATE INDEX `sessionUserIdIndex` ON `sessions` (`userId`);--> statement-breakpoint
CREATE TABLE `squadEventAssociations` (
	`serverEventId` integer NOT NULL,
	`squadId` integer NOT NULL,
	`createdAt` integer,
	PRIMARY KEY(`serverEventId`, `squadId`),
	FOREIGN KEY (`serverEventId`) REFERENCES `serverEvents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`squadId`) REFERENCES `squads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `squadEventAssociationsSquadIdIndex` ON `squadEventAssociations` (`squadId`);--> statement-breakpoint
CREATE TABLE `squads` (
	`id` integer PRIMARY KEY NOT NULL,
	`ingameSquadId` integer NOT NULL,
	`teamId` integer NOT NULL,
	`name` text NOT NULL,
	`creatorId` text,
	`createdAt` integer,
	FOREIGN KEY (`creatorId`) REFERENCES `players`(`eosId`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `nameIndex` ON `squads` (`name`);--> statement-breakpoint
CREATE INDEX `creatorIdIndex` ON `squads` (`creatorId`);--> statement-breakpoint
CREATE TABLE `users` (
	`discordId` text PRIMARY KEY NOT NULL,
	`steam64Id` text,
	`username` text NOT NULL,
	`nickname` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_steam64Id_unique` ON `users` (`steam64Id`);