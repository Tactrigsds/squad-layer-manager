CREATE TABLE `linkedSteamAccounts` (
	`steam64Id` text PRIMARY KEY NOT NULL,
	`discordId` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`discordId`) REFERENCES `users`(`discordId`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `linkedSteamDiscordIdIndex` ON `linkedSteamAccounts` (`discordId`);--> statement-breakpoint
DROP INDEX `users_steam64Id_unique`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `steam64Id`;