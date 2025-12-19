ALTER TABLE `matchHistory` ADD `createdAt` timestamp;
--> statement-breakpoint
ALTER TABLE `matchHistory` MODIFY `createdAt` timestamp DEFAULT CURRENT_TIMESTAMP;
