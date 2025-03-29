ALTER TABLE `matchHistory` ADD `setByType` enum('user','system','unknown');--> statement-breakpoint
ALTER TABLE `matchHistory` ADD `setByUserId` bigint unsigned;--> statement-breakpoint
CREATE INDEX `layerIdIndex` ON `matchHistory` (`layerId`);--> statement-breakpoint
CREATE INDEX `startTimeIndex` ON `matchHistory` (`startTime`);--> statement-breakpoint
CREATE INDEX `endTimeIndex` ON `matchHistory` (`endTime`);--> statement-breakpoint
CREATE INDEX `userIndex` ON `matchHistory` (`setByUserId`);