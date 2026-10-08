-- Keep scheduled temporary-state cleanup bounded and indexed.
CREATE INDEX IF NOT EXISTS idx_machine_tickets_retention ON machine_tickets(expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_challenges_retention ON auth_challenges(expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_retention ON auth_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_platform_binding_codes_retention ON platform_binding_codes(expires_at);
CREATE INDEX IF NOT EXISTS idx_operation_locks_retention ON operation_locks(expires_at);
