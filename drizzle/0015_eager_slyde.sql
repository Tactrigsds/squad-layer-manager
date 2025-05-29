DROP TABLE `subfactions`;--> statement-breakpoint
DROP TABLE `factions`;--> statement-breakpoint
ALTER TABLE `layers` RENAME COLUMN `SubFac_1` TO `Unit_1`;--> statement-breakpoint
ALTER TABLE `layers` RENAME COLUMN `SubFac_2` TO `Unit_2`;--> statement-breakpoint
DROP INDEX `subfac1Index` ON `layers`;--> statement-breakpoint
DROP INDEX `subfac2Index` ON `layers`;--> statement-breakpoint
CREATE INDEX `unit1Index` ON `layers` (`Unit_1`);--> statement-breakpoint
CREATE INDEX `unit2Index` ON `layers` (`Unit_2`);
