DROP INDEX `logistics1Index` ON `layers`;--> statement-breakpoint
DROP INDEX `transportation1Index` ON `layers`;--> statement-breakpoint
DROP INDEX `antiInfantry1Index` ON `layers`;--> statement-breakpoint
DROP INDEX `armor1Index` ON `layers`;--> statement-breakpoint
DROP INDEX `zeroScore1Index` ON `layers`;--> statement-breakpoint
DROP INDEX `logistics2Index` ON `layers`;--> statement-breakpoint
DROP INDEX `transportation2Index` ON `layers`;--> statement-breakpoint
DROP INDEX `antiInfantry2Index` ON `layers`;--> statement-breakpoint
DROP INDEX `armor2Index` ON `layers`;--> statement-breakpoint
DROP INDEX `zeroScore2Index` ON `layers`;--> statement-breakpoint
DROP INDEX `balanceDifferentialIndex` ON `layers`;--> statement-breakpoint
DROP INDEX `asymmetryScoreIndex` ON `layers`;--> statement-breakpoint
DROP INDEX `logisticsDiffIndex` ON `layers`;--> statement-breakpoint
DROP INDEX `transportationDiffIndex` ON `layers`;--> statement-breakpoint
DROP INDEX `antiInfantryDiffIndex` ON `layers`;--> statement-breakpoint
DROP INDEX `armorDiffIndex` ON `layers`;--> statement-breakpoint
DROP INDEX `zeroScoreDiffIndex` ON `layers`;--> statement-breakpoint
DROP INDEX `Z_PoolIndex` ON `layers`;--> statement-breakpoint
DROP INDEX `ScoredIndex` ON `layers`;--> statement-breakpoint
ALTER TABLE `layers` DROP COLUMN `Logistics_1`;--> statement-breakpoint
ALTER TABLE `layers` DROP COLUMN `Transportation_1`;--> statement-breakpoint
ALTER TABLE `layers` DROP COLUMN `Anti-Infantry_1`;--> statement-breakpoint
ALTER TABLE `layers` DROP COLUMN `Armor_1`;--> statement-breakpoint
ALTER TABLE `layers` DROP COLUMN `ZERO_Score_1`;--> statement-breakpoint
ALTER TABLE `layers` DROP COLUMN `Logistics_2`;--> statement-breakpoint
ALTER TABLE `layers` DROP COLUMN `Transportation_2`;--> statement-breakpoint
ALTER TABLE `layers` DROP COLUMN `Anti-Infantry_2`;--> statement-breakpoint
ALTER TABLE `layers` DROP COLUMN `Armor_2`;--> statement-breakpoint
ALTER TABLE `layers` DROP COLUMN `ZERO_Score_2`;--> statement-breakpoint
ALTER TABLE `layers` DROP COLUMN `Balance_Differential`;--> statement-breakpoint
ALTER TABLE `layers` DROP COLUMN `Asymmetry_Score`;--> statement-breakpoint
ALTER TABLE `layers` DROP COLUMN `Logistics_Diff`;--> statement-breakpoint
ALTER TABLE `layers` DROP COLUMN `Transportation_Diff`;--> statement-breakpoint
ALTER TABLE `layers` DROP COLUMN `Anti-Infantry_Diff`;--> statement-breakpoint
ALTER TABLE `layers` DROP COLUMN `Armor_Diff`;--> statement-breakpoint
ALTER TABLE `layers` DROP COLUMN `ZERO_Score_Diff`;--> statement-breakpoint
ALTER TABLE `layers` DROP COLUMN `Z_Pool`;--> statement-breakpoint
ALTER TABLE `layers` DROP COLUMN `Scored`;