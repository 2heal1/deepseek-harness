SELECT id, version, created_at, cwd, parent_session, seed_length, origin,
       delegation_depth, agent_preset, runtime_profile, incarnation, revision
FROM sessions
WHERE id = ?;
