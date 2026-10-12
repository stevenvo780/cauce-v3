CREATE INDEX messages_diagnostic_trace_idx ON messages(trace_id);
CREATE INDEX terminal_sessions_diagnostic_trace_idx ON terminal_sessions(trace_id);
CREATE INDEX audit_diagnostic_message_idx ON audit_events(message_id);
CREATE INDEX audit_diagnostic_delivery_idx ON audit_events(delivery_id);
CREATE INDEX audit_diagnostic_receipts_idx ON audit_events USING gin(metadata jsonb_path_ops);
CREATE INDEX audit_diagnostic_backup_id_idx ON audit_events((metadata->>'id')) WHERE action LIKE 'space.backup.%';
CREATE INDEX audit_diagnostic_context_idx ON audit_events(
  (COALESCE(metadata->>'target_tenant',tenant_id)),
  (COALESCE(metadata->>'target_alias',actor_alias)),
  (metadata->>'version')
) WHERE action IN ('context.version','context.sync');
