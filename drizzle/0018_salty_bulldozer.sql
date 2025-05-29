ALTER TABLE `layers` MODIFY COLUMN `Logistics_1` float DEFAULT null;--> statement-breakpoint
ALTER TABLE `layers` MODIFY COLUMN `Transportation_1` float DEFAULT null;--> statement-breakpoint
ALTER TABLE `layers` MODIFY COLUMN `Anti-Infantry_1` float DEFAULT null;--> statement-breakpoint
ALTER TABLE `layers` MODIFY COLUMN `Armor_1` float DEFAULT null;--> statement-breakpoint
ALTER TABLE `layers` MODIFY COLUMN `ZERO_Score_1` float DEFAULT null;--> statement-breakpoint
ALTER TABLE `layers` MODIFY COLUMN `Logistics_2` float DEFAULT null;--> statement-breakpoint
ALTER TABLE `layers` MODIFY COLUMN `Transportation_2` float DEFAULT null;--> statement-breakpoint
ALTER TABLE `layers` MODIFY COLUMN `Anti-Infantry_2` float DEFAULT null;--> statement-breakpoint
ALTER TABLE `layers` MODIFY COLUMN `Armor_2` float DEFAULT null;--> statement-breakpoint
ALTER TABLE `layers` MODIFY COLUMN `ZERO_Score_2` float DEFAULT null;--> statement-breakpoint
ALTER TABLE `layers` MODIFY COLUMN `Balance_Differential` float DEFAULT null;--> statement-breakpoint
ALTER TABLE `layers` MODIFY COLUMN `Asymmetry_Score` float DEFAULT null;--> statement-breakpoint
ALTER TABLE `layers` MODIFY COLUMN `Logistics_Diff` float DEFAULT null;--> statement-breakpoint
ALTER TABLE `layers` MODIFY COLUMN `Transportation_Diff` float DEFAULT null;--> statement-breakpoint
ALTER TABLE `layers` MODIFY COLUMN `Anti-Infantry_Diff` float DEFAULT null;--> statement-breakpoint
ALTER TABLE `layers` MODIFY COLUMN `Armor_Diff` float DEFAULT null;--> statement-breakpoint
ALTER TABLE `layers` MODIFY COLUMN `ZERO_Score_Diff` float DEFAULT null;--> statement-breakpoint
CREATE INDEX `alliance1Index` ON `layers` (`Alliance_1`);--> statement-breakpoint
CREATE INDEX `alliance2Index` ON `layers` (`Alliance_2`);