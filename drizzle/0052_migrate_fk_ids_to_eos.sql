ALTER TABLE `playerEventAssociations` ADD COLUMN `playerId_new` varchar(32);--> statement-breakpoint
UPDATE `playerEventAssociations` pea
  INNER JOIN `players` p ON p.`steamId` = pea.`playerId`
  SET pea.`playerId_new` = p.`eosId`;--> statement-breakpoint
DELETE FROM `playerEventAssociations` WHERE `playerId_new` IS NULL;--> statement-breakpoint
ALTER TABLE `playerEventAssociations` DROP COLUMN `playerId`;--> statement-breakpoint
ALTER TABLE `playerEventAssociations` RENAME COLUMN `playerId_new` TO `playerId`;--> statement-breakpoint
ALTER TABLE `playerEventAssociations` MODIFY COLUMN `playerId` varchar(32) NOT NULL;--> statement-breakpoint
ALTER TABLE `squads` ADD COLUMN `creatorId_new` varchar(32);--> statement-breakpoint
UPDATE `squads` s
  INNER JOIN `players` p ON p.`steamId` = s.`creatorId`
  SET s.`creatorId_new` = p.`eosId`;--> statement-breakpoint
ALTER TABLE `squads` DROP COLUMN `creatorId`;--> statement-breakpoint
ALTER TABLE `squads` RENAME COLUMN `creatorId_new` TO `creatorId`;--> statement-breakpoint
ALTER TABLE `playerEventAssociations` ADD CONSTRAINT `playerEventAssociations_playerId_players_eosId_fk` FOREIGN KEY (`playerId`) REFERENCES `players`(`eosId`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `squads` ADD CONSTRAINT `squads_creatorId_players_eosId_fk` FOREIGN KEY (`creatorId`) REFERENCES `players`(`eosId`) ON DELETE set null ON UPDATE no action;
