# ruff: noqa: F821
"""Company scope and identities shared by the doctor's sourced libraries."""


def guard_company_id():
    value = os.environ.get("CAUCE_GUARD_COMPANY_ID", "humanizar")
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", value):
        raise ValueError("invalid CAUCE_GUARD_COMPANY_ID")
    return value


def company_scoped_query(query):
    company = guard_company_id()
    relations = {
        "tenants": ((), f"company_id='{company}'"),
        "companies": ((), f"id='{company}'"),
        "agents": (("tenants",), "tenant_id IN (SELECT id FROM tenants)"),
        "rooms": (("tenants",), "tenant_id IN (SELECT id FROM tenants)"),
        "messages": (("tenants",), "tenant_id IN (SELECT id FROM tenants)"),
        "deliveries": (("tenants", "messages"), "recipient_tenant IN (SELECT id FROM tenants) "
                       "AND message_id IN (SELECT id FROM messages)"),
        "delivery_acks": (("deliveries",), "delivery_id IN (SELECT id FROM deliveries)"),
        "human_message_initiators": (("messages",), "message_id IN (SELECT id FROM messages)"),
        "channel_bridge_cursors": (("tenants",), "tenant_id IN (SELECT id FROM tenants)"),
        "dead_letters": (("tenants",), "tenant_id IN (SELECT id FROM tenants)"),
        "outbox_dead_letters": (("tenants",), "tenant_id IN (SELECT id FROM tenants)"),
        "audit_events": (("tenants", "messages"),
                         "(tenant_id IS NULL OR tenant_id IN (SELECT id FROM tenants)) "
                         "AND (message_id IS NULL OR message_id IN (SELECT id FROM messages)) "
                         "AND (tenant_id IS NOT NULL OR message_id IS NOT NULL) "
                         "AND (to_jsonb(audit_events)->>'company_id' IS NULL "
                         f"OR to_jsonb(audit_events)->>'company_id'='{company}')"),
        "doctor_container_scopes": ((), None),
    }
    references = re.findall(r"\b(?:from|join)\s+([a-z_][a-z0-9_]*)(\s*\.)?", query, re.IGNORECASE)
    local_ctes = set(re.findall(r"\b([a-z_][a-z0-9_]*)\s+as\s*(?:(?:not\s+)?materialized\s*)?\(", query.lower()))
    used = set()
    for name, qualified in references:
        name = name.lower()
        if qualified or name not in relations and name not in local_ctes:
            raise ValueError("doctor query references an unscoped relation")
        if name in relations:
            used.add(name)
    scoped = []
    emitted = set()

    def append(name):
        if name in emitted:
            return
        dependencies, predicate = relations[name]
        for dependency in dependencies:
            append(dependency)
        if name == "doctor_container_scopes":
            scoped.append(f"{name} AS (SELECT a.container_name, bool_or(t.company_id='{company}') in_company "
                          "FROM public.agents a JOIN public.tenants t ON t.id=a.tenant_id "
                          "WHERE a.container_name IS NOT NULL AND a.container_name<>'' GROUP BY a.container_name)")
        else:
            scoped.append(f"{name} AS (SELECT * FROM public.{name} WHERE {predicate})")
        emitted.add(name)

    for name in sorted(used):
        append(name)
    if not scoped:
        return query
    body = query.lstrip()
    if re.match(r"with\s+recursive\b", body, re.IGNORECASE):
        raise ValueError("recursive doctor queries are unsupported")
    if re.match(r"with\s", body, re.IGNORECASE):
        body = re.sub(r"^with\s+", "", body, count=1, flags=re.IGNORECASE)
        return "WITH " + ", ".join(scoped) + ", " + body
    return "WITH " + ", ".join(scoped) + " " + body


def scoped_inventory():
    return DOCTOR_INVENTORY if DOCTOR_INVENTORY is not None else inventario()


def runtime_identities(inventory):
    return {row["runtime_key"]: identity for identity, row in inventory.items() if row.get("runtime_key")}


def scope_units(units, inventory):
    identities = runtime_identities(inventory)
    return {identities[key]: value for key, value in units.items() if key in identities}


def safe_last_error(value):
    value = str(value or "")
    code = "TRANSPORT" if RE_ERROR_DE_TRANSPORTE.match(value) else "AGENT"
    return f"LAST_ERROR_{code} chars={len(value)}" if value else "LAST_ERROR_EMPTY chars=0"


def notice_identity():
    identity = ("Steven", ALIAS_AVISO)
    return identity if guard_company_id() == "humanizar" and identity in scoped_inventory() else None


CONTAINER_FINDING_TYPES = {"bucle_de_cuota", "bucle_de_cuota_barato", "bucle_de_cuota_adjudicado", "sonda_bucle"}


def finding_subject(record):
    return record.get("cuenta") or record.get("contenedor") or record.get("alias") or "-"


def finding_memory_key(record):
    alias = record.get("alias", "-")
    if alias == "-" and record.get("tipo") in CONTAINER_FINDING_TYPES | {"cuenta_ia"}:
        alias = finding_subject(record)
    return f"{record.get('tipo', '?')}|{record.get('tenant', '-')}|{alias}"


def scope_findings(records):
    inventory = scoped_inventory()
    scoped = []
    for record in records:
        if record.get("company_id", guard_company_id()) != guard_company_id():
            continue
        if record.get("tenant") is not None and record["tenant"] not in {key[0] for key in inventory}:
            continue
        alias = record.get("alias")
        if record.get("tipo") == "cuenta_ia":
            record = dict(record)
            record.pop("tenant", None)
            scoped.append(record)
            continue
        if record.get("tipo") in CONTAINER_FINDING_TYPES and (record.get("contenedor") or alias not in (None, "-")):
            container = record.get("contenedor") or alias
            matches = [key for key, row in inventory.items() if row.get("contenedor_db") == container]
            if not matches and (DOCTOR_CONTAINER_SCOPES or {}).get(container) is False:
                continue
            record = {**record, "contenedor": container, "alias": "-"}
            record.pop("tenant", None)
            if len(matches) == 1:
                record.update(tenant=matches[0][0], alias=matches[0][1])
            scoped.append(record)
            continue
        if not alias or alias == "-":
            scoped.append(record)
            continue
        if isinstance(alias, (list, tuple)) and alias and isinstance(alias[0], (list, tuple)):
            identities = [tuple(key) for key in alias]
            if all(key in inventory for key in identities):
                scoped.append({**record, "tenant": identities[0][0],
                               "alias": identities[0][1] if len(identities) == 1
                               else ",".join("/".join(key) for key in identities)})
            continue
        identities = []
        for part in str(alias).split(","):
            keys = [key for key in inventory if part == "/".join(key)
                    or key[1] == part and record.get("tenant", key[0]) == key[0]]
            if len(keys) != 1:
                break
            identities.extend(keys)
        else:
            if identities:
                scoped.append({**record, "tenant": identities[0][0],
                               "alias": identities[0][1] if len(identities) == 1 else alias})
    return scoped


def scope_finding_memory(records):
    inventory = scoped_inventory()
    scoped = {}
    for key, value in (records if isinstance(records, dict) else {}).items():
        parts = key.split("|")
        if len(parts) != 3:
            continue
        global_subject = parts[1] == "-" and (parts[0] == "cuenta_ia" or
                         parts[0] in CONTAINER_FINDING_TYPES and (DOCTOR_CONTAINER_SCOPES or {}).get(parts[2]) is not False)
        if tuple(parts[1:]) in inventory or parts[1:] == ["-", "-"] or global_subject:
            scoped[key] = value
    return scoped


def check_book_scope():
    inventory = scoped_inventory()
    if len({alias for _, alias in inventory}) != len(inventory):
        raise RuntimeError("legacy task book requires unambiguous scoped aliases")
    for path in (LIBRO_JSON, EVIDENCIA_JSON):
        if os.path.exists(path):
            with open(path) as stream:
                value = json.load(stream)
            if not isinstance(value, dict) or value.get("_doctor_company_id") != guard_company_id():
                raise RuntimeError("persisted task book has no verified company scope")


def mark_book_scope():
    for path in (LIBRO_JSON, EVIDENCIA_JSON):
        if os.path.exists(path):
            with open(path) as stream:
                value = json.load(stream)
            if not isinstance(value, dict):
                raise RuntimeError("task book persistence requires an object")
            value["_doctor_company_id"] = guard_company_id()
            with open(path, "w") as stream:
                json.dump(value, stream)


def lost_work_rows():
    return sql("""
        WITH failed AS (
          SELECT recipient_tenant tenant, recipient_alias alias, count(*) n, max(created_at) latest,
            (array_agg(coalesce(last_error,'') ORDER BY created_at DESC))[1] error
          FROM deliveries WHERE status IN ('failed','dead') AND attempt <= 1
            AND created_at > now() - interval '24 hours' GROUP BY recipient_tenant,recipient_alias
        )
        SELECT f.tenant,f.alias,f.n::text,f.error,
          to_char(f.latest AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI'),
          (SELECT count(*) FROM deliveries d WHERE d.recipient_tenant=f.tenant AND d.recipient_alias=f.alias
            AND d.status='done' AND coalesce(d.terminal_at,d.updated_at)>f.latest)::text,
          (SELECT count(*) FROM deliveries d JOIN messages m ON m.id=d.message_id
            WHERE d.recipient_tenant=f.tenant AND d.recipient_alias=f.alias AND d.status IN ('failed','dead')
              AND d.attempt<=1 AND d.created_at>now()-interval '24 hours'
              AND (coalesce(m.body->>'text','') ILIKE '%prueba de vida%' OR coalesce(m.body->>'text','') LIKE '%PROBAR-%'
                OR coalesce(m.body->>'text','') ILIKE '%no es trabajo%'))::text,
          (SELECT count(*) FROM deliveries d JOIN messages m ON m.id=d.message_id
            WHERE d.recipient_tenant=f.tenant AND d.recipient_alias=f.alias AND d.status IN ('failed','dead')
              AND d.attempt<=1 AND d.created_at>now()-interval '24 hours' AND coalesce(d.result->'output'->>'reply','')=''
              AND NOT (coalesce(m.body->>'text','') ILIKE '%prueba de vida%' OR coalesce(m.body->>'text','') LIKE '%PROBAR-%'
                OR coalesce(m.body->>'text','') ILIKE '%no es trabajo%'))::text
        FROM failed f ORDER BY f.n DESC
    """, columnas=8)


def doctor_failed_notices():
    return sql("""
        SELECT d.recipient_tenant,d.recipient_alias,count(*)::text,
          to_char(max(d.created_at) AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI'),
          coalesce((array_agg(d.last_error ORDER BY d.created_at DESC))[1],''),
          coalesce(to_char((SELECT max(d2.created_at) FROM deliveries d2 JOIN messages m2 ON m2.id=d2.message_id
            WHERE m2.body->>'guardia'='cauce-medico-monitor' AND d2.recipient_tenant=d.recipient_tenant
              AND d2.recipient_alias=d.recipient_alias AND d2.status='done'
              AND d2.created_at>now()-interval '24 hours') AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI'),'')
        FROM deliveries d JOIN messages m ON m.id=d.message_id
        WHERE m.body->>'guardia'='cauce-medico-monitor' AND d.status IN ('failed','dead')
          AND d.created_at>now()-interval '24 hours' GROUP BY d.recipient_tenant,d.recipient_alias
        ORDER BY d.recipient_tenant,d.recipient_alias
    """, columnas=6)
