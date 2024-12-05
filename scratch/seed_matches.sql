-- First query: Insert the matches with start times and other data
INSERT INTO dblog.DBLog_Matches (mapClassname,
                                 layerClassname,
                                 map,
                                 layer,
                                 startTime,
                                 tickets,
                                 winner,
                                 team1,
                                 team2,
                                 team1Short,
                                 team2Short,
                                 subFactionTeam1,
                                 subFactionTeam2,
                                 subFactionShortTeam1,
                                 subFactionShortTeam2,
                                 winnerTeam,
                                 winnerTeamID,
                                 isDraw,
                                 server)
SELECT Level                                                                                        as mapClassname,
       Layer                                                                                        as layerClassname,
       Level                                                                                        as map,
       Layer                                                                                        as layer,
       DATE_SUB(DATE_SUB(NOW(), INTERVAL FLOOR(RAND() * 30) DAY), INTERVAL FLOOR(RAND() * 24) HOUR) as startTime,
       FLOOR(100 + RAND() * 400)                                                                    as tickets,
       CASE FLOOR(RAND() * 2)
           WHEN 0 THEN Faction_1
           WHEN 1 THEN Faction_2
           END                                                                                      as winner,
       Faction_1                                                                                    as team1,
       Faction_2                                                                                    as team2,
       Faction_1                                                                                    as team1Short,
       Faction_2                                                                                    as team2Short,
       SubFac_1                                                                                     as subFactionTeam1,
       SubFac_2                                                                                     as subFactionTeam2,
       SubFac_1                                                                                     as subFactionShortTeam1,
       SubFac_2                                                                                     as subFactionShortTeam2,
       CASE FLOOR(RAND() * 2)
           WHEN 0 THEN Faction_1
           WHEN 1 THEN Faction_2
           END                                                                                      as winnerTeam,
       FLOOR(RAND() * 2) + 1                                                                        as winnerTeamID,
       false                                                                                        as isDraw,
       1                                                                                            as server
FROM layers
ORDER BY RAND()
LIMIT 150;

-- Second query: Update end times based on start times
UPDATE dblog.DBLog_Matches
SET endTime = DATE_ADD(startTime, INTERVAL FLOOR(30 + RAND() * 30) MINUTE)
WHERE endTime IS NULL
ORDER BY startTime;
