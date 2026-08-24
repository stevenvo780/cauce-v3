# PLAN: Extensión de PTY-Agent + Terminal-Relay para lectura de ficheros de gobierno

**Estado:** Diseño detallado + interfaz gateway. Implementación pendiente en pty-agent y terminal-relay.

---

## Resumen ejecutivo

El gateway ahora tiene:
- ✅ Route `/v3/console/agents/:tenant/:alias/directive` 
- ✅ Interfaz `AgentFactsProbe.readGovernanceDocument()` y `listMemoryDirectory()`
- ✅ Tests unitarios (usando mock probe)
- 🚩 Implementación real del probe: necesita pty-agent + terminal-relay para leer ficheros

Lo que FALTA es la **cadena de lectura** desde gateway → terminal-relay → pty-agent.

---

## Arquitectura propuesta

```
┌─────────────────────────────────────────────────────────────────┐
│ GATEWAY (en kratos)                                             │
├─────────────────────────────────────────────────────────────────┤
│ probe.readGovernanceDocument(path, facts, tenantId, alias)     │
│   └─→ terminal-relay.readFile(tenantId, alias, path)          │
└─────────────────────────────────────────────────────────────────┘
                            ↓ TLS
┌─────────────────────────────────────────────────────────────────┐
│ TERMINAL-RELAY (en kratos)                                      │
├─────────────────────────────────────────────────────────────────┤
│ relay.handleReadFileRequest(tenantId, alias, path)             │
│   └─→ agent_conn.readFile(path) → [frames]                    │
└─────────────────────────────────────────────────────────────────┘
                            ↓ TLS (mutual)
┌─────────────────────────────────────────────────────────────────┐
│ PTY-AGENT (dentro del contenedor)                              │
├─────────────────────────────────────────────────────────────────┤
│ handle TAG_READ_FILE(path)                                     │
│   1. Validar path (NEVER_SERVE, realpath, juego cerrado)      │
│   2. Leer fichero                                              │
│   3. Enviar TAG_READ_FILE_OK + DATA frames                    │
│   4. Si error → TAG_READ_FILE_ERR                             │
└─────────────────────────────────────────────────────────────────┘
```

---

## Decisiones de diseño

### 1. Protocolo: ¿TAG nuevo o modo en TAG_OPEN?

**RECOMENDACIÓN: TAG nuevo (0x50-0x52)** porque:
- `TAG_OPEN` abre **sesiones persistentes** (terminales con I/O bidireccional).
- Lectura de fichero es **stateless**: one-shot request/response.
- Mezclarlos haría el estado más confuso.

**Tags propuestos:**
```python
TAG_READ_FILE = 0x50      # Solicitud: path + opciones
TAG_READ_FILE_OK = 0x51   # OK: envía DATA frames, luego cierra
TAG_READ_FILE_ERR = 0x52  # Error: reason string
```

**Payload de TAG_READ_FILE:**
```python
# JSON: { "path": "/absolute/path" }
# El pty-agent valida y responde.
```

---

### 2. Validación de seguridad (CRÍTICA)

El pty-agent DEBE rechazar ANTES de leer:

**a) Ruta fuera del juego cerrado**
```python
allowed_paths = resolveAgentDocuments(facts).map(d => d.path)
if path not in allowed_paths:
  return TAG_READ_FILE_ERR("ruta no permitida")
```

**b) Symlinks**
```python
realpath = os.path.realpath(path)
if realpath != path:
  return TAG_READ_FILE_ERR("symlink detectado")
```
*(Defensa en profundidad: gateway también lo valida, pero el pty-agent no debe confiar.)*

**c) Credenciales (NEVER_SERVE)**
```python
NEVER_SERVE = ['.credentials.json', 'auth.json', '.env', '.netrc', 'id_ed25519', ...]
basename = os.path.basename(path)
if basename in NEVER_SERVE or path.endswith(('.pem', '.key', '.p12', '.pfx')):
  return TAG_READ_FILE_ERR("no se sirve")
```

**d) Tamaño máximo**
```python
MAX_DOCUMENT_BYTES = 256 * 1024
stat = os.stat(path)
if stat.st_size > MAX_DOCUMENT_BYTES:
  # Truncar: leer solo los primeros 256 KB
  # Enviar DATA frames + flag "truncated"
```

**e) Permisos: nunca elevar**
```python
# El pty-agent corre como el usuario del arnés (ej: stev para kant)
# NO hacer sudo, NO elevar permisos
# Si el usuario no puede leer el fichero, devolver "permission_denied"
```

---

### 3. Transporte de datos

**Coalescing (como hoy para STDOUT):**
- Si el fichero es > 64 KB, enviar en múltiples DATA frames (máx 8 KB/frame).
- Terminal-relay acumula los frames y devuelve al gateway.

**Timeout:**
- Esperar respuesta del pty-agent: **5 segundos** máximo.
- Si timeout: devolver `{ error: 'timeout', reason: '...' }` al gateway.

**Backpressure:**
- Si hay múltiples lecturas en vuelo, respetar `OUTBOUND_HIGH_WATER` existente.
- No invertir la presión acá.

---

## Implementación: PTY-Agent (Python)

**Archivo:** `ops/pty-agent/cauce_pty_agent.py`

### Pseudocódigo

```python
# 1. Extender el enum de tags
TAG_READ_FILE = 0x50
TAG_READ_FILE_OK = 0x51
TAG_READ_FILE_ERR = 0x52

# 2. Extender la clase Agent
class Agent:
    async def handle_read_file(self, payload_json):
        """
        Maneja TAG_READ_FILE: lee un fichero con validaciones severas.
        """
        try:
            request = json.loads(payload_json)
            path = request.get("path")
            if not isinstance(path, str):
                return await self.send_error("invalid_request", "path requerido")
            
            # 🚩 VALIDACIÓN CRÍTICA
            result = self.validate_read_path(path)
            if not result.allowed:
                return await self.send_error(result.error_code, result.reason)
            
            # 🚩 LECTURA CON LÍMITE
            content, truncated = self.read_file_limited(path, MAX_DOCUMENT_BYTES)
            
            # Obtener metadata
            stat = os.stat(path)
            modified_at = datetime.fromtimestamp(stat.st_mtime).isoformat()
            
            # 🚩 Enviar respuesta
            await self.send_read_file_ok(
                path=path,
                content=content,
                bytes=stat.st_size,
                truncated=truncated,
                modified_at=modified_at,
            )
        except Exception as e:
            await self.send_error("unknown", f"lectura falló: {type(e).__name__}")
    
    def validate_read_path(self, path: str):
        """
        Valida que la ruta se pueda leer. Retorna { allowed, error_code, reason }.
        """
        # 1. Ruta absoluta
        if not path.startswith('/'):
            return error("invalid_path", "path no es absoluto")
        
        # 2. Ruta sin ".."
        if ".." in path.split('/'):
            return error("invalid_path", "path sube de directorio")
        
        # 3. Null byte
        if '\0' in path:
            return error("invalid_path", "ruta con byte nulo")
        
        # 4. Symlink
        realpath = os.path.realpath(path)
        if realpath != path:
            return error("symlink_detected", "ruta es enlace simbólico")
        
        # 5. NEVER_SERVE
        basename = os.path.basename(path)
        if basename in NEVER_SERVE_BASENAMES:
            return error("permission_denied", f"no se sirve {basename}")
        for suffix in NEVER_SERVE_SUFFIXES:
            if basename.endswith(suffix):
                return error("permission_denied", f"no se sirve {suffix}")
        
        # 6. ¿El fichero existe?
        if not os.path.exists(path):
            return error("not_found", f"{path} no existe")
        
        # 7. ¿Es un fichero regular? (no directorio, no device, etc.)
        if not os.path.isfile(path):
            return error("invalid_path", f"{path} no es un fichero regular")
        
        # 8. ¿El usuario actual puede leerlo?
        try:
            os.stat(path)
        except PermissionError:
            return error("permission_denied", f"permiso denegado: {path}")
        
        return ok()
    
    def read_file_limited(self, path: str, max_bytes: int):
        """
        Lee el fichero, truncando a max_bytes si es necesario.
        Retorna (contenido, truncated).
        """
        with open(path, 'rb') as f:
            content = f.read(max_bytes + 1)  # Leer un byte más para detectar truncamiento
            truncated = len(content) > max_bytes
            if truncated:
                content = content[:max_bytes]
            return content.decode('utf-8', errors='replace'), truncated
    
    async def send_read_file_ok(self, path, content, bytes, truncated, modified_at):
        """
        Envía TAG_READ_FILE_OK + DATA frames con el contenido.
        """
        # Primero, header con metadata (JSON compacto)
        header = {
            "path": path,
            "bytes": bytes,
            "truncated": truncated,
            "modified_at": modified_at,
        }
        await self.send_frame(TAG_READ_FILE_OK, json.dumps(header).encode())
        
        # Luego, DATA frames con el contenido (coalescing)
        content_bytes = content.encode('utf-8')
        for i in range(0, len(content_bytes), MAX_DATA):
            chunk = content_bytes[i:i+MAX_DATA]
            await self.send_frame(TAG_STDOUT, chunk)  # O un tag DATA dedicado
        
        # Cerrar la lectura (si es necesario un cierre explícito)
        # Probablemente no; los DATA frames terminan la transacción.
```

### Validaciones en el pty-agent (tabla de seguridad)

| Validación | Cómo | Marca |
|---|---|---|
| Ruta absoluta | `path.startswith('/')` | 🚩 CRÍTICO |
| Sin ".." | `'..' not in path.split('/')` | 🚩 CRÍTICO |
| Sin null bytes | `'\0' not in path` | 🚩 CRÍTICO |
| No symlink | `os.path.realpath(path) == path` | 🚩 CRÍTICO |
| No en NEVER_SERVE | Comparar basename + suffixes | 🚩 CRÍTICO |
| Existe | `os.path.exists(path)` | ⭐ |
| Es fichero regular | `os.path.isfile(path)` | ⭐ |
| Permiso de lectura | `os.stat(path)` (no throws) | ⭐ |
| Tamaño ≤ 256 KB | Leer + truncar si es necesario | ⭐ |

---

## Implementación: Terminal-Relay (TypeScript)

**Archivos:** `services/terminal-relay/src/agent-leg.ts` y `services/terminal-relay/src/gateway-client.ts`

### En agent-leg.ts (comunicación con pty-agent)

```typescript
/**
 * Maneja frames TAG_READ_FILE_OK / _ERR que vienen del pty-agent.
 * Acumula DATA frames y los pasa al gateway.
 */
export async function handleReadFileResponse(
  connection: AgentConnection,
  tag: number,
  payload: Buffer,
): Promise<void> {
  if (tag === TAG_READ_FILE_OK) {
    const metadata = JSON.parse(payload.toString('utf-8'));
    // Acumular DATA frames hasta completar
    // Pasar al gateway mediante callback o stream
  } else if (tag === TAG_READ_FILE_ERR) {
    const reason = payload.toString('utf-8');
    // Pasar error al gateway
  }
}
```

### En gateway-client.ts (comunicación con gateway)

```typescript
/**
 * Solicita la lectura de un fichero del pty-agent.
 * Devuelve una promesa que se resuelve cuando el pty-agent responde.
 */
export async function requestFileRead(
  connection: AgentConnection,
  tenantId: string,
  alias: string,
  path: string,
  timeoutMs: number = 5000,
): Promise<FileReadResponse | FileReadError> {
  const request = { path };
  
  // Enviar TAG_READ_FILE
  connection.sendFrame(TAG_READ_FILE, JSON.stringify(request));
  
  // Esperar respuesta (con timeout)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Read timeout'));
    }, timeoutMs);
    
    // Registrar callback para cuando llegue TAG_READ_FILE_OK / _ERR
    connection.onReadFileResponse = (response) => {
      clearTimeout(timer);
      resolve(response);
    };
  });
}

interface FileReadResponse {
  path: string;
  content: string;
  bytes: number;
  truncated: boolean;
  modified_at: string;
}

interface FileReadError {
  error: 'not_found' | 'permission_denied' | 'symlink_detected' | 'timeout' | 'unknown';
  reason: string;
}
```

---

## Implementación: Probe en Gateway

**Archivo:** `services/gateway/src/console/facts-probe.ts` (NUEVO o EXTENDER)

```typescript
/**
 * Implementación real del AgentFactsProbe que llama a terminal-relay.
 * Hoy solo existe el pty-agent y la medición de facts. Esto agrega lectura de fichero.
 */
export class TerminalRelayFactsProbe implements AgentFactsProbe {
  constructor(private relay: TerminalRelayClient) {}
  
  async readGovernanceDocument(
    path: string,
    facts: RuntimeFacts,
    tenantId: string,
    alias: string,
  ): Promise<GovernanceDocumentContent | GovernanceReadError> {
    try {
      // 🚩 DEFENSA EN PROFUNDIDAD: validar acá TAMBIÉN
      const verdict = this.verifyReadablePath(path, facts);
      if (!verdict.allowed) {
        return { error: 'invalid_path', reason: verdict.reason || 'ruta no permitida' };
      }
      
      // Llamar al terminal-relay
      const response = await this.relay.readFile(tenantId, alias, path);
      
      if ('error' in response) {
        return response as GovernanceReadError;
      }
      
      return response as GovernanceDocumentContent;
    } catch (error) {
      return {
        error: 'timeout' as const,
        reason: `lectura no respondió en tiempo: ${error instanceof Error ? error.message : ''}`,
      };
    }
  }
  
  async listMemoryDirectory(
    memoryRoot: string,
    facts: RuntimeFacts,
    tenantId: string,
    alias: string,
  ): Promise<MemoryDirectoryListing | GovernanceReadError> {
    // Similar: validar memoryRoot, llamar relay.listDir(), manejo de errores
    // 🚩 Validar que memoryRoot es permitido para este arnés
    throw new Error('Not implemented yet');
  }
  
  private verifyReadablePath(path: string, facts: RuntimeFacts): { allowed: boolean; reason?: string } {
    // Reusar la lógica de verifyWritablePath pero para LECTURA
    // Básicamente lo mismo: ruta absoluta, no "..", no symlink, no NEVER_SERVE
    throw new Error('Not implemented yet');
  }
}
```

---

## Tests esperados

### PTY-Agent (Python)

**Unit tests:**
```python
def test_read_file_ok():
  # Crear fichero temporal, pedir lectura, verificar contenido

def test_reject_symlink():
  # Crear symlink, pedir lectura, verificar error

def test_reject_never_serve():
  # Crear .credentials.json, pedir lectura, verificar error

def test_truncate_large_file():
  # Crear fichero >256 KB, pedir lectura, verificar truncated=true

def test_reject_path_outside_home():
  # Pedir /etc/passwd, verificar error

def test_permission_denied():
  # Crear fichero con permisos 000, pedir lectura, verificar error
```

**Integration tests:**
```python
def test_read_claude_md_from_real_container():
  # Esperar que el gateway pida lectura, devolver CLAUDE.md
```

### Terminal-Relay (TypeScript)

**Unit tests:**
```typescript
it('decodes TAG_READ_FILE_OK frames', () => {
  const payload = ...;
  const response = decodeReadFileOk(payload);
  expect(response.path).toEqual(...);
});

it('handles TAG_READ_FILE_ERR with reason', () => {
  const response = decodeReadFileErr(...);
  expect(response.error).toBe('not_found');
});
```

### Gateway (TypeScript)

**Integration tests:**
```typescript
it('readGovernanceDocument calls relay and returns content', async () => {
  const probe = new TerminalRelayFactsProbe(mockRelay);
  const result = await probe.readGovernanceDocument(...);
  expect(result).toHaveProperty('text');
});
```

---

## Riesgos de seguridad a revisar ANTES de desplegar

| Riesgo | Ubicación | Cómo mitigarlo |
|---|---|---|
| **Lectura de /etc/passwd** | pty-agent | Validar que path está en juego cerrado |
| **Symlink a credenciales** | pty-agent | Verificar `realpath(path) == path` |
| **Credencial directa (.credentials.json)** | gateway + pty-agent | NEVER_SERVE en ambos sitios |
| **Elevación de permisos** | pty-agent | NUNCA hacer sudo; fallar cerrado |
| **DoS: leer archivo 1 GB** | pty-agent | Truncar a 256 KB; timeout 5 seg |
| **Race: fichero borrado entre validación y lectura** | pty-agent | Capturar FileNotFoundError, devolver error |
| **Injection en JSON** | gateway + relay | Validar tipos; no concatenar paths |
| **Timeout cuelga el gateway** | gateway | Promise.race(lectura, timeout) |

---

## Tabla de implementación completeness

| Componente | Estado | Notas |
|---|---|---|
| **Gateway Route** | ✅ HECHO | `/v3/console/agents/:tenant/:alias/directive` |
| **Tipos TypeScript** | ✅ HECHO | AgentDirective, AgentDirectiveFile, etc. |
| **Interfaz AgentFactsProbe** | ✅ HECHO | readGovernanceDocument, listMemoryDirectory |
| **Tests del route** | ✅ HECHO | Mock probe, casos: medido/no medido/error |
| **PTY-Agent: protocolo** | 🚩 PLAN | TAG_READ_FILE/OK/ERR definido |
| **PTY-Agent: validación** | 🚩 PLAN | Pseudocódigo, tabla de checks |
| **PTY-Agent: lectura** | 🚩 PLAN | Lectura + truncación + coalescing |
| **Terminal-Relay: handler** | 🚩 PLAN | Acumular frames, pasar al gateway |
| **Gateway Probe: impl.** | 🚩 PLAN | Llamar terminal-relay, manejo de errores |
| **Integration tests** | 🚩 PLAN | End-to-end con pty-agent real |

---

## Cómo continuar

1. **Revisar este plan** — ¿hay dudas sobre las decisiones?
2. **Implementar pty-agent** — Seguir pseudocódigo, tests unit, defender en profundidad.
3. **Implementar terminal-relay** — Frame handling, timeout, acumulation.
4. **Implementar probe en gateway** — Llamadas a relay, manejo de errores.
5. **Tests integration** — Que el gateway pueda leer un CLAUDE.md real dentro de un contenedor.
6. **Revisión de seguridad** — Antes de desplegar a producción, revisar la tabla de riesgos.

**Médico responsable:** Revisar antes de desplegar. 🚩 = NO HACERLO SIN SEGUNDA REVISIÓN.

---

## Referencias

- Protocolo pty-agent: `ops/pty-agent/cauce_pty_agent.py` (frame tags, hello, session management)
- Terminal-relay: `services/terminal-relay/src/` (agent-leg.ts, gateway-client.ts, framing.ts)
- Gateway: `services/gateway/src/console/` (agent-documents.routes.ts, agent-documents.ts)
- Tipos de console: `apps/console/src/api/types.ts` (AgentDirective, etc.)
- Validaciones de seguridad: `services/gateway/src/console/agent-documents.ts` (NEVER_SERVE_BASENAMES, verifyWritablePath, etc.)
