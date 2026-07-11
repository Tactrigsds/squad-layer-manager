CREATE TABLE `timeouts` (
	`id` text PRIMARY KEY NOT NULL,
	`playerId` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`cancelled` integer DEFAULT false NOT NULL,
	`createdAt` integer NOT NULL,
	`appEventId` text,
	`issuedServerId` text,
	`reasonLabel` text,
	`reasonMessage` text,
	FOREIGN KEY (`playerId`) REFERENCES `players`(`eosId`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`appEventId`) REFERENCES `appEvents`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`issuedServerId`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `timeoutsPlayerActiveIndex` ON `timeouts` (`playerId`,`cancelled`,`expiresAt`);--> statement-breakpoint
CREATE INDEX `timeoutsExpiresAtIndex` ON `timeouts` (`expiresAt`);