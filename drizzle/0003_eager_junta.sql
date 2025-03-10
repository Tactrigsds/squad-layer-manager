CREATE TABLE `matchHistory` (
	`id` int AUTO_INCREMENT NOT NULL,
	`layerId` varchar(256) NOT NULL,
	`startTime` timestamp NOT NULL,
	`endTime` timestamp,
	`winner` enum('team1','team2','draw'),
	`team1Tickets` int,
	`team2Tickets` int,
	CONSTRAINT `matchHistory_id` PRIMARY KEY(`id`)
);
