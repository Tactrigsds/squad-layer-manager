-- Events with data.json.player storing a steam ID
UPDATE `serverEvents` se
INNER JOIN `players` p ON p.`steamId` = CAST(JSON_UNQUOTE(JSON_EXTRACT(se.`data`, '$.json.player')) AS UNSIGNED)
SET se.`data` = JSON_SET(se.`data`, '$.json.player', p.`eosId`)
WHERE se.`type` IN (
  'PLAYER_DISCONNECTED', 'CHAT_MESSAGE', 'PLAYER_DETAILS_CHANGED',
  'PLAYER_CHANGED_TEAM', 'PLAYER_LEFT_SQUAD', 'PLAYER_JOINED_SQUAD',
  'PLAYER_PROMOTED_TO_LEADER', 'PLAYER_KICKED', 'POSSESSED_ADMIN_CAMERA',
  'UNPOSSESSED_ADMIN_CAMERA', 'PLAYER_BANNED', 'PLAYER_WARNED'
)
AND JSON_TYPE(JSON_EXTRACT(se.`data`, '$.json.player')) = 'STRING';--> statement-breakpoint
-- PLAYER_DIED / PLAYER_WOUNDED: victim field
UPDATE `serverEvents` se
INNER JOIN `players` p ON p.`steamId` = CAST(JSON_UNQUOTE(JSON_EXTRACT(se.`data`, '$.json.victim')) AS UNSIGNED)
SET se.`data` = JSON_SET(se.`data`, '$.json.victim', p.`eosId`)
WHERE se.`type` IN ('PLAYER_DIED', 'PLAYER_WOUNDED')
AND JSON_TYPE(JSON_EXTRACT(se.`data`, '$.json.victim')) = 'STRING';--> statement-breakpoint
-- PLAYER_DIED / PLAYER_WOUNDED: attacker field
UPDATE `serverEvents` se
INNER JOIN `players` p ON p.`steamId` = CAST(JSON_UNQUOTE(JSON_EXTRACT(se.`data`, '$.json.attacker')) AS UNSIGNED)
SET se.`data` = JSON_SET(se.`data`, '$.json.attacker', p.`eosId`)
WHERE se.`type` IN ('PLAYER_DIED', 'PLAYER_WOUNDED')
AND JSON_TYPE(JSON_EXTRACT(se.`data`, '$.json.attacker')) = 'STRING';--> statement-breakpoint
-- SQUAD_CREATED: squad.creator field
UPDATE `serverEvents` se
INNER JOIN `players` p ON p.`steamId` = CAST(JSON_UNQUOTE(JSON_EXTRACT(se.`data`, '$.json.squad.creator')) AS UNSIGNED)
SET se.`data` = JSON_SET(se.`data`, '$.json.squad.creator', p.`eosId`)
WHERE se.`type` = 'SQUAD_CREATED'
AND JSON_TYPE(JSON_EXTRACT(se.`data`, '$.json.squad.creator')) = 'STRING';
