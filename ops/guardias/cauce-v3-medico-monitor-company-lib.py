# ruff: noqa: F821
"""Company scope and identities shared by the doctor's sourced libraries."""


def guard_company_id():
    value = os.environ.get("CAUCE_GUARD_COMPANY_ID", "humanizar")
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", value):
        raise ValueError("invalid CAUCE_GUARD_COMPANY_ID")
    return value


DOCTOR_CONTAINER_SCOPE_QUERY = "SELECT container_name,in_company FROM doctor_container_scopes"


DOCTOR_SQL_FUNCTIONS = {
    "array_agg", "coalesce", "count", "extract", "greatest", "json_build_object", "left", "length",
    "max", "min", "now", "position", "regexp_replace", "round", "string_agg", "to_char",
}
DOCTOR_SQL_CAST_TYPES = {"text", "integer"}


def doctor_query_casts(tokens, parentheses):
    for index, token in enumerate(tokens):
        if tokens[index:index+2] == [":", ":"]:
            if index+2 >= len(tokens) or tokens[index+2] not in DOCTOR_SQL_CAST_TYPES or (
                tokens[index+3:index+4] == ["."]
            ):
                raise ValueError("doctor query uses an unsupported cast type")
        if token != "cast" or tokens[index+1:index+2] != ["("]:
            continue
        end = parentheses[index+1]
        cursor = index + 2
        while cursor < end:
            if tokens[cursor] == "(":
                cursor = parentheses[cursor] + 1
            elif tokens[cursor] == "as":
                if cursor+2 != end or tokens[cursor+1] not in DOCTOR_SQL_CAST_TYPES:
                    raise ValueError("doctor query uses an unsupported cast type")
                break
            else:
                cursor += 1
        else:
            raise ValueError("doctor query requires CAST AS syntax")


def doctor_query_ctes(tokens, parentheses):
    definitions, openings = {}, set()
    if tokens[0] != "with":
        return definitions, openings
    index = 1
    while index < len(tokens):
        name = tokens[index]
        if not re.fullmatch(r"[a-z_][a-z0-9_]*", name) or name in definitions:
            raise ValueError("doctor query has an invalid or duplicate CTE")
        index += 1
        if tokens[index:index+1] != ["as"]:
            raise ValueError("doctor query requires CTE AS syntax without column lists")
        index += 1
        if tokens[index:index+1] == ["not"]:
            if tokens[index+1:index+2] != ["materialized"]:
                raise ValueError("doctor query has invalid CTE materialization")
            index += 2
        elif tokens[index:index+1] == ["materialized"]:
            index += 1
        if tokens[index:index+2] != ["(", "select"] or index not in parentheses:
            raise ValueError("doctor query requires SELECT inside each CTE")
        openings.add(index)
        definitions[name] = parentheses[index]
        index = parentheses[index] + 1
        if tokens[index:index+1] == [","]:
            index += 1
            continue
        if tokens[index:index+1] != ["select"]:
            raise ValueError("doctor query requires SELECT after the initial CTEs")
        return definitions, openings
    raise ValueError("doctor query has incomplete CTE definitions")


def doctor_query_structure(query):
    for marker, reason in (("\"", "double quotes"), ("--", "comments"), ("/*", "comments"), (";", "semicolons")):
        if marker in query:
            raise ValueError(f"doctor query does not support {reason}")
    literals = re.compile(r"'(?:[^']|'')*'")
    if "\\'" in query or any(re.search(r"\b(?:e|u&)\s*$", query[:literal.start()], re.IGNORECASE)
                              for literal in literals.finditer(query)):
        raise ValueError("doctor query has unsupported string syntax")
    literal_prefixes = {"select", "where", "having", "on", "and", "or", "not", "in", "when", "then", "else",
                        "like", "ilike", "interval", "timestamp", "zone"}
    for literal in literals.finditer(query):
        before = query[:literal.start()].lower()
        prefix = re.search(r"\b([a-z_][a-z0-9_]*)\s*$", before)
        if prefix and (prefix[1] not in literal_prefixes or before[:prefix.start()].rstrip().endswith(".") or (
            prefix[1] == "zone" and not re.search(r"\bat\s+time\s+zone\s*$", before)
        )):
            raise ValueError("doctor query has an unsupported typed literal")
    structure = literals.sub(" ", query).lower()
    if "'" in structure or "$" in structure:
        raise ValueError("doctor query has unsupported string syntax")
    if not structure.isascii():
        raise ValueError("doctor query has unsupported non-ASCII identifiers")
    if re.search(r"\btable\s+[a-z_]", structure):
        raise ValueError("doctor query does not support TABLE syntax")
    tokens = re.findall(r"[a-z_][a-z0-9_]*|[^\s]", structure)
    if not tokens or tokens[0] not in {"select", "with"}:
        raise ValueError("doctor query must begin with SELECT or WITH")
    forbidden = {"insert", "update", "delete", "merge", "into", "truncate", "copy", "call", "do",
                 "grant", "alter", "create", "drop", "regclass"}
    if forbidden.intersection(tokens):
        raise ValueError("doctor query forbids write and relation lookup tokens")
    if "recursive" in tokens:
        raise ValueError("recursive doctor queries are unsupported")
    if "with" in tokens[1:] or "window" in tokens:
        raise ValueError("doctor query does not support nested WITH or WINDOW")
    parentheses, stack = {}, []
    for index, token in enumerate(tokens):
        if token == "(":
            stack.append(index)
        elif token == ")":
            if not stack:
                raise ValueError("doctor query has unbalanced parentheses")
            parentheses[stack.pop()] = index
    if stack:
        raise ValueError("doctor query has unbalanced parentheses")
    local_ctes, cte_openings = doctor_query_ctes(tokens, parentheses)
    doctor_query_casts(tokens, parentheses)
    frames = [[False, None]]
    references = []
    group_keywords = {"select", "from", "where", "having", "on", "and", "or", "not", "in", "exists",
                      "using", "as", "when", "then", "else", "distinct", "cast"}
    endings = {"where", "group", "having", "order", "limit", "offset", "fetch",
               "union", "intersect", "except", "for"}
    for index, token in enumerate(tokens):
        if token == "(":
            previous = tokens[index-1] if index else None
            if previous and re.fullmatch(r"[a-z_][a-z0-9_]*", previous):
                if (index > 1 and tokens[index-2] == ".") or (
                    previous not in DOCTOR_SQL_FUNCTIONS | group_keywords and index not in cte_openings
                ):
                    raise ValueError("doctor query calls an unsupported function")
            frames.append([False, previous])
        elif token == ")":
            if len(frames) == 1:
                raise ValueError("doctor query has unbalanced parentheses")
            frames.pop()
        elif token in endings and (not index or tokens[index-1] != "."):
            frames[-1][0] = False
        elif token == "," and frames[-1][0]:
            raise ValueError("doctor query does not support comma joins; use explicit JOIN")
        elif token in {"from", "join"} and frames[-1][1] != "extract":
            frames[-1][0] = True
            following = tokens[index+1:index+3]
            if following and following[0] == "(":
                if len(following) != 2 or following[1] not in {"select", "with"}:
                    raise ValueError("doctor query has an unsupported parenthesized relation")
            elif following and re.fullmatch(r"[a-z_][a-z0-9_]*", following[0]):
                if len(following) == 2 and following[1] == "(":
                    raise ValueError("doctor query does not support functions in FROM or JOIN")
                references.append((following[0], len(following) == 2 and following[1] == ".", index))
            else:
                raise ValueError("doctor query references an unscoped relation")
    if len(frames) != 1:
        raise ValueError("doctor query has unbalanced parentheses")
    return structure, references, local_ctes


def company_scoped_query(query, *, internal=False):
    company = guard_company_id()
    if re.search(r"\bdoctor_container_scopes\b", query, re.IGNORECASE):
        if not internal or query != DOCTOR_CONTAINER_SCOPE_QUERY:
            raise ValueError("container ownership is reserved for the internal doctor reader")
    _, references, local_ctes = doctor_query_structure(query)
    relations = {
        "tenants": ((), f"company_id='{company}'"),
        "companies": ((), f"id='{company}'"),
        "agents": (("tenants",), "tenant_id IN (SELECT id FROM tenants)"),
        "rooms": (("tenants",), "tenant_id IN (SELECT id FROM tenants)"),
        "messages": (("tenants",), "tenant_id IN (SELECT id FROM tenants)"),
        "deliveries": (("tenants", "messages"), "recipient_tenant IN (SELECT id FROM tenants) "
                       "AND message_id IN (SELECT id FROM messages)"),
        "delivery_acks": (("deliveries",), "delivery_id IN (SELECT id FROM deliveries)"),
        "adapter_outbox": (("tenants", "messages", "deliveries"),
                           "tenant_id IN (SELECT id FROM tenants) AND message_id IN (SELECT id FROM messages) "
                           "AND (delivery_id IS NULL OR delivery_id IN (SELECT id FROM deliveries))"),
        "telegram_egress_effects": (("tenants", "adapter_outbox"),
                                    "tenant_id IN (SELECT id FROM tenants) "
                                    "AND outbox_id IN (SELECT id FROM adapter_outbox)"),
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
    if local_ctes.keys() & relations.keys():
        raise ValueError("doctor query CTEs cannot shadow scoped relations")
    used = set()
    for name, qualified, index in references:
        if qualified or name not in relations and name not in local_ctes:
            raise ValueError("doctor query references an unscoped relation")
        if name in local_ctes and local_ctes[name] >= index:
            raise ValueError("doctor query references a CTE before its definition")
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
    if re.match(r"with\s", body, re.IGNORECASE):
        body = re.sub(r"^with\s+", "", body, count=1, flags=re.IGNORECASE)
        return "WITH " + ", ".join(scoped) + ", " + body
    return "WITH " + ", ".join(scoped) + " " + body


def doctor_container_scopes():
    return {container: belongs == "t" for container, belongs in
            sql(DOCTOR_CONTAINER_SCOPE_QUERY, columnas=2, internal=True)}


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
    alias = record.get("alias")
    if record.get("tenant") and alias not in (None, "-") and "," not in str(alias) and "/" not in str(alias):
        return f"{record['tenant']}/{alias}"
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
