-- What each chat platform calls a player, kept on that platform's identity.
--
-- A player bound on two platforms has two names; each is updated only by its
-- own platform, and a bot speaks of the player by the name on its platform.
-- The player's own name (`players.display_name`) is filled from an identity
-- only while it is still a placeholder, such as an imported "Player 75".
ALTER TABLE player_identities ADD COLUMN display_name TEXT;
