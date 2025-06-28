CREATE TABLE `balanceTriggerEvents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`triggerId` varchar(64) NOT NULL,
	`version` int NOT NULL,
	`matchTriggeredId` int,
	`strongerTeam` enum('teamA','teamB') NOT NULL,
	`input` json NOT NULL,
	`evaulationResult` json NOT NULL,
	CONSTRAINT `balanceTriggerEvents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `balanceTriggerEvents` ADD CONSTRAINT `balanceTriggerEvents_matchTriggeredId_matchHistory_id_fk` FOREIGN KEY (`matchTriggeredId`) REFERENCES `matchHistory`(`id`) ON DELETE cascade ON UPDATE no action;