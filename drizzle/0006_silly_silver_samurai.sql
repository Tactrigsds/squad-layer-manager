CREATE TABLE `genLayerColumnOrder` (
	`ordinal` int NOT NULL,
	`columnName` varchar(255) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `genLayerWeights` (
	`columnName` varchar(255) NOT NULL,
	`value` varchar(255) NOT NULL,
	`weight` float NOT NULL
);
