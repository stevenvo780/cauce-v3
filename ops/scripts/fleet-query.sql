SELECT jsonb_build_object(
  'agents', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'tenant_id', agent.tenant_id,
      'alias', agent.alias,
      'harness_id', agent.harness_id,
      'enabled', agent.enabled,
      'container_name', agent.container_name,
      'runtime_user', agent.runtime_user,
      'home_directory', agent.home_directory,
      'state_directory', agent.state_directory,
      'runtime_key', to_jsonb(agent)->>'runtime_key',
      'primary_room_id', to_jsonb(agent)->>'primary_room_id',
      'lifecycle_state', to_jsonb(agent)->>'lifecycle_state',
      'host_id', to_jsonb(agent)->>'host_id',
      'runtime_mode', to_jsonb(agent)->>'runtime_mode',
      'systemd_user', to_jsonb(agent)->>'systemd_user'
    ) ORDER BY agent.tenant_id, agent.alias)
    FROM agents AS agent
  ), '[]'::jsonb),
  'memberships', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'tenant_id', membership.tenant_id,
      'alias', membership.alias,
      'room_id', membership.room_id,
      'role', membership.role,
      'enabled', membership.enabled
    ) ORDER BY membership.tenant_id, membership.alias, membership.room_id)
    FROM memberships AS membership
  ), '[]'::jsonb),
  'rolePolicies', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'role', policy.role
    ) ORDER BY policy.role)
    FROM role_policies AS policy
  ), '[]'::jsonb)
);
