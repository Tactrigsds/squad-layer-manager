ALTER TABLE `players` ADD COLUMN `epicId` varchar(32);--> statement-breakpoint
ALTER TABLE `players` ADD CONSTRAINT `players_epicId_unique` UNIQUE(`epicId`);
