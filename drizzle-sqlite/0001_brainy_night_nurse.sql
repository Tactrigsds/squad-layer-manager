CREATE TABLE `appEvents` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`time` integer NOT NULL,
	`actorType` text NOT NULL,
	`actorUserId` text,
	`actorPlayerId` text,
	`serverId` text,
	`matchId` integer,
	`causeId` text,
	`version` integer DEFAULT 1,
	`data` text NOT NULL,
	FOREIGN KEY (`serverId`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`matchId`) REFERENCES `matchHistory`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `appEventTypeIndex` ON `appEvents` (`type`);--> statement-breakpoint
CREATE INDEX `appEventTimeIndex` ON `appEvents` (`time`);--> statement-breakpoint
CREATE INDEX `appEventServerIdIndex` ON `appEvents` (`serverId`);--> statement-breakpoint
CREATE INDEX `appEventMatchIdIndex` ON `appEvents` (`matchId`);--> statement-breakpoint
CREATE INDEX `appEventActorUserIdIndex` ON `appEvents` (`actorUserId`);--> statement-breakpoint
ALTER TABLE `serverEvents` ADD `appEventId` text REFERENCES appEvents(id);--> statement-breakpoint
CREATE INDEX `appEventIdIndex` ON `serverEvents` (`appEventId`);