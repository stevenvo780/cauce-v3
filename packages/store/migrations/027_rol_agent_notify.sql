-- Inserta y valida la política de rol 'agent_notify' para permitir notificaciones proactivas.
-- Asegura que los permisos sean exactamente (allow_route=true, allow_read=true, allow_control=false, allow_notify=true).

INSERT INTO role_policies(role, allow_route, allow_read, allow_control, allow_notify)
VALUES ('agent_notify', true, true, false, true)
ON CONFLICT (role) DO NOTHING;

DO $$
BEGIN
  PERFORM 1 FROM role_policies WHERE role='agent_notify' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '027 failed to create the agent_notify role policy';
  END IF;
  IF EXISTS (
    SELECT 1 FROM role_policies
     WHERE role='agent_notify'
       AND ROW(allow_route,allow_read,allow_control,allow_notify)
           IS DISTINCT FROM ROW(true,true,false,true)
  ) THEN
    RAISE EXCEPTION '027 refuses divergent agent_notify role policy';
  END IF;
END $$;
