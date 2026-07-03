ALTER TABLE `matchHistory` DROP FOREIGN KEY `matchHistory_serverId_servers_id_fk`;
--> statement-breakpoint
ALTER TABLE `matchHistory` ADD CONSTRAINT `matchHistory_serverId_servers_id_fk` FOREIGN KEY (`serverId`) REFERENCES `servers`(`id`) ON DELETE cascade ON UPDATE no action;