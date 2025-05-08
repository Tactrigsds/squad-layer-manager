ALTER TABLE `layers` RENAME COLUMN `Level` TO `Map`;--> statement-breakpoint
DROP INDEX `levelIndex` ON `layers`;--> statement-breakpoint
CREATE INDEX `levelIndex` ON `layers` (`Map`);