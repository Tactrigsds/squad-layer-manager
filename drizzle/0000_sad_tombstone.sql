CREATE TABLE `factions` (
	`shortName` varchar(255) NOT NULL,
	`fullName` varchar(255) NOT NULL,
	`alliance` varchar(255) NOT NULL,
	CONSTRAINT `factions_shortName` PRIMARY KEY(`shortName`)
);
--> statement-breakpoint
CREATE TABLE `filterRoleContributors` (
	`filterId` varchar(64) NOT NULL,
	`roleId` varchar(32) NOT NULL,
	CONSTRAINT `filterRoleContributors_filterId_roleId_pk` PRIMARY KEY(`filterId`,`roleId`)
);
--> statement-breakpoint
CREATE TABLE `filterUserContributors` (
	`filterId` varchar(64) NOT NULL,
	`userId` bigint NOT NULL,
	CONSTRAINT `filterUserContributors_filterId_userId_pk` PRIMARY KEY(`filterId`,`userId`)
);
--> statement-breakpoint
CREATE TABLE `filters` (
	`id` varchar(64) NOT NULL,
	`name` varchar(128) NOT NULL,
	`description` varchar(512),
	`filter` json NOT NULL,
	`owner` bigint,
	CONSTRAINT `filters_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `layers` (
	`id` varchar(64) NOT NULL,
	`Level` varchar(255) NOT NULL,
	`Layer` varchar(255) NOT NULL,
	`Size` varchar(255) NOT NULL,
	`Gamemode` varchar(255) NOT NULL,
	`LayerVersion` varchar(255),
	`Faction_1` varchar(255) NOT NULL,
	`SubFac_1` varchar(255),
	`Logistics_1` float,
	`Transportation_1` float,
	`Anti-Infantry_1` float,
	`Armor_1` float,
	`ZERO_Score_1` float,
	`Faction_2` varchar(255) NOT NULL,
	`SubFac_2` varchar(255),
	`Logistics_2` float,
	`Transportation_2` float,
	`Anti-Infantry_2` float,
	`Armor_2` float,
	`ZERO_Score_2` float,
	`Balance_Differential` float,
	`Asymmetry_Score` float,
	`Logistics_Diff` float,
	`Transportation_Diff` float,
	`Anti-Infantry_Diff` float,
	`Armor_Diff` float,
	`ZERO_Score_Diff` float,
	`Z_Pool` boolean NOT NULL DEFAULT false,
	`Scored` boolean NOT NULL DEFAULT false,
	CONSTRAINT `layers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `servers` (
	`id` varchar(256) NOT NULL,
	`online` boolean NOT NULL DEFAULT false,
	`displayName` varchar(256) NOT NULL,
	`layerQueueSeqId` int NOT NULL DEFAULT 0,
	`layerQueue` json NOT NULL DEFAULT ('{"json":[]}'),
	`historyFilters` json NOT NULL DEFAULT ('{"json":[]}'),
	`settings` json DEFAULT ('{"json":{}}'),
	`lastRoll` timestamp,
	CONSTRAINT `servers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`session` varchar(255) NOT NULL,
	`userId` bigint NOT NULL,
	`expiresAt` timestamp NOT NULL,
	CONSTRAINT `sessions_session` PRIMARY KEY(`session`)
);
--> statement-breakpoint
CREATE TABLE `subfactions` (
	`shortName` varchar(255) NOT NULL,
	`factionShortName` varchar(255) NOT NULL,
	`fullName` varchar(255) NOT NULL,
	CONSTRAINT `subfactions_shortName_factionShortName_unique` UNIQUE(`shortName`,`factionShortName`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`discordId` bigint NOT NULL,
	`username` varchar(32) NOT NULL,
	`avatar` varchar(255),
	CONSTRAINT `users_discordId` PRIMARY KEY(`discordId`)
);
--> statement-breakpoint
ALTER TABLE `filterRoleContributors` ADD CONSTRAINT `filterRoleContributors_filterId_filters_id_fk` FOREIGN KEY (`filterId`) REFERENCES `filters`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `filterUserContributors` ADD CONSTRAINT `filterUserContributors_filterId_filters_id_fk` FOREIGN KEY (`filterId`) REFERENCES `filters`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `filterUserContributors` ADD CONSTRAINT `filterUserContributors_userId_users_discordId_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`discordId`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `filters` ADD CONSTRAINT `filters_owner_users_discordId_fk` FOREIGN KEY (`owner`) REFERENCES `users`(`discordId`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_userId_users_discordId_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`discordId`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subfactions` ADD CONSTRAINT `subfactions_factionShortName_factions_shortName_fk` FOREIGN KEY (`factionShortName`) REFERENCES `factions`(`shortName`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `fullNameIndex` ON `factions` (`fullName`);--> statement-breakpoint
CREATE INDEX `allianceIndex` ON `factions` (`alliance`);--> statement-breakpoint
CREATE INDEX `levelIndex` ON `layers` (`Level`);--> statement-breakpoint
CREATE INDEX `layerIndex` ON `layers` (`Layer`);--> statement-breakpoint
CREATE INDEX `sizeIndex` ON `layers` (`Size`);--> statement-breakpoint
CREATE INDEX `gamemodeIndex` ON `layers` (`Gamemode`);--> statement-breakpoint
CREATE INDEX `layerVersionIndex` ON `layers` (`LayerVersion`);--> statement-breakpoint
CREATE INDEX `faction1Index` ON `layers` (`Faction_1`);--> statement-breakpoint
CREATE INDEX `subfac1Index` ON `layers` (`SubFac_1`);--> statement-breakpoint
CREATE INDEX `faction2Index` ON `layers` (`Faction_2`);--> statement-breakpoint
CREATE INDEX `subfac2Index` ON `layers` (`SubFac_2`);--> statement-breakpoint
CREATE INDEX `logistics1Index` ON `layers` (`Logistics_1`);--> statement-breakpoint
CREATE INDEX `transportation1Index` ON `layers` (`Transportation_1`);--> statement-breakpoint
CREATE INDEX `antiInfantry1Index` ON `layers` (`Anti-Infantry_1`);--> statement-breakpoint
CREATE INDEX `armor1Index` ON `layers` (`Armor_1`);--> statement-breakpoint
CREATE INDEX `zeroScore1Index` ON `layers` (`ZERO_Score_1`);--> statement-breakpoint
CREATE INDEX `logistics2Index` ON `layers` (`Logistics_2`);--> statement-breakpoint
CREATE INDEX `transportation2Index` ON `layers` (`Transportation_2`);--> statement-breakpoint
CREATE INDEX `antiInfantry2Index` ON `layers` (`Anti-Infantry_2`);--> statement-breakpoint
CREATE INDEX `armor2Index` ON `layers` (`Armor_2`);--> statement-breakpoint
CREATE INDEX `zeroScore2Index` ON `layers` (`ZERO_Score_2`);--> statement-breakpoint
CREATE INDEX `balanceDifferentialIndex` ON `layers` (`Balance_Differential`);--> statement-breakpoint
CREATE INDEX `asymmetryScoreIndex` ON `layers` (`Asymmetry_Score`);--> statement-breakpoint
CREATE INDEX `logisticsDiffIndex` ON `layers` (`Logistics_Diff`);--> statement-breakpoint
CREATE INDEX `transportationDiffIndex` ON `layers` (`Transportation_Diff`);--> statement-breakpoint
CREATE INDEX `antiInfantryDiffIndex` ON `layers` (`Anti-Infantry_Diff`);--> statement-breakpoint
CREATE INDEX `armorDiffIndex` ON `layers` (`Armor_Diff`);--> statement-breakpoint
CREATE INDEX `zeroScoreDiffIndex` ON `layers` (`ZERO_Score_Diff`);--> statement-breakpoint
CREATE INDEX `Z_PoolIndex` ON `layers` (`Z_Pool`);--> statement-breakpoint
CREATE INDEX `ScoredIndex` ON `layers` (`Scored`);--> statement-breakpoint
CREATE INDEX `expiresAtIndex` ON `sessions` (`expiresAt`);--> statement-breakpoint
CREATE INDEX `fullName` ON `subfactions` (`fullName`);--> statement-breakpoint
CREATE INDEX `factionShortName` ON `subfactions` (`factionShortName`);
