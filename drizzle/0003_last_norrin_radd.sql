CREATE TABLE `matchHistory` (
	`id` int AUTO_INCREMENT NOT NULL,
	`layerId` varchar(256) NOT NULL,
	`startTime` timestamp NOT NULL,
	`endTime` timestamp,
	`outcome` enum('team1','team2','draw'),
	`team1Tickets` int,
	`team2Tickets` int,
	`setByType` enum('manual','gameserver','generated','unknown') NOT NULL,
	`setByUserId` bigint unsigned,
	CONSTRAINT `matchHistory_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `layerIdIndex` ON `matchHistory` (`layerId`);--> statement-breakpoint
CREATE INDEX `startTimeIndex` ON `matchHistory` (`startTime`);--> statement-breakpoint
CREATE INDEX `endTimeIndex` ON `matchHistory` (`endTime`);--> statement-breakpoint
CREATE INDEX `userIndex` ON `matchHistory` (`setByUserId`);