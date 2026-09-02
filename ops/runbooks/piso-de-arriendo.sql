-- Lease floor applied by hand in production on connection_leases: raises lease_until to
-- 180 s so a late heartbeat (every 15 s) does not fence a healthy agent. Not in any migration;
-- reapply after any restore or schema rebuild. Verify: SELECT tgname FROM pg_trigger WHERE tgname='cauce_piso_de_arriendo_trg';
CREATE OR REPLACE FUNCTION public.cauce_piso_de_arriendo()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- PARCHE OPERATIVO 2026-08-23 (zeus/medico). agora al 90% de STEAL de CPU.
  -- TTL del arriendo CLAVADO a 30 s en el codigo (leaseTtlMs ?? 30_000), sin variable de entorno.
  -- Con la CPU estrangulada el latido (cada 15 s) llega tarde, el arriendo caduca, y como el
  -- propio UPDATE del latido exige "lease_until > now()", el agente SANO queda vallado fuera y
  -- solo vuelve reconectando (janus llevaba epoch 7601).
  -- Solo ALARGA arriendos fijados HACIA EL FUTURO (latido/conexion).
  -- releaseLease fija lease_until = now() exacto -> no es > now() -> soltar sigue soltando.
  IF NEW.lease_until > now() AND NEW.lease_until < now() + interval '180 seconds' THEN
    NEW.lease_until := now() + interval '180 seconds';
  END IF;
  RETURN NEW;
END;
$function$

DROP TRIGGER IF EXISTS cauce_piso_de_arriendo_trg ON connection_leases;
CREATE TRIGGER cauce_piso_de_arriendo_trg BEFORE INSERT OR UPDATE ON public.connection_leases FOR EACH ROW EXECUTE FUNCTION cauce_piso_de_arriendo();
