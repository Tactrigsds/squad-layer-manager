UPDATE `matchHistory`
SET `createdAt` = `startTime`
WHERE `startTime` IS NOT NULL AND `createdAt` IS NULL;
--> statement-breakpoint
UPDATE `matchHistory` mh
INNER JOIN (
  SELECT matchId, MIN(time) as earliest_time
  FROM `serverEvents`
  WHERE `type` = 'NEW_GAME'
  GROUP BY matchId
) se ON mh.id = se.matchId
SET mh.`createdAt` = se.earliest_time
WHERE mh.`createdAt` IS NULL;
