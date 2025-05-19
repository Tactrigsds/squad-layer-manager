ALTER TABLE `genLayerColumnOrder` ADD PRIMARY KEY(`columnName`);--> statement-breakpoint
ALTER TABLE `genLayerWeights` ADD PRIMARY KEY(`columnName`,`value`);--> statement-breakpoint
CREATE INDEX `columnNameIndex` ON `genLayerWeights` (`columnName`);--> statement-breakpoint
CREATE INDEX `valueIndex` ON `genLayerWeights` (`value`);