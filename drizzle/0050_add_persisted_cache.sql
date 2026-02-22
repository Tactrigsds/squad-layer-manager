CREATE TABLE `persistedCache` (
	`key` varchar(256) NOT NULL,
	`value` json NOT NULL,
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `persistedCache_key` PRIMARY KEY(`key`)
);
