
ALTER TABLE `filterUserContributors` DROP FOREIGN KEY `filterUserContributors_userId_users_discordId_fk`;
--> statement-breakpoint
ALTER TABLE `filters` DROP FOREIGN KEY `filters_owner_users_discordId_fk`;
--> statement-breakpoint
ALTER TABLE `sessions` DROP FOREIGN KEY `sessions_userId_users_discordId_fk`;
--> statement-breakpoint
ALTER TABLE `filterUserContributors` MODIFY COLUMN `userId` bigint unsigned NOT NULL;

--> statement-breakpoint
ALTER TABLE `filters` MODIFY COLUMN `owner` bigint unsigned;
--> statement-breakpoint
ALTER TABLE `sessions` MODIFY COLUMN `userId` bigint unsigned NOT NULL;
--> statement-breakpoint
ALTER TABLE `users` MODIFY COLUMN `discordId` bigint unsigned NOT NULL;

--> statement-breakpoint
ALTER TABLE `filterUserContributors` ADD CONSTRAINT `filterUserContributors_userId_users_discordId_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`discordId`) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE `filters` ADD CONSTRAINT `filters_owner_users_discordId_fk` FOREIGN KEY (`owner`) REFERENCES `users`(`discordId`) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_userId_users_discordId_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`discordId`) ON DELETE CASCADE;
