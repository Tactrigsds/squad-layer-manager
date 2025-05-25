ALTER TABLE `matchHistory` RENAME COLUMN `vote` TO `layerVote`;--> statement-breakpoint
ALTER TABLE `matchHistory` MODIFY COLUMN `startTime` timestamp;--> statement-breakpoint
ALTER TABLE `matchHistory` ADD `lqItemId` varchar(256);