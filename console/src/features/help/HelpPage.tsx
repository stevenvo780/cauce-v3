export function HelpPage() {
  return (
    <div className="section">
      <div className="section-header">
        <div>
          <h1>Ayuda y documentación</h1>
          <p className="muted">
            Guía de referencia para operadores: vistas del sistema, estados de la flota y atajos de teclado.
          </p>
        </div>
      </div>

      <div style={{ display: 'grid', gap: '24px', marginTop: '16px' }}>
        <div className="card">
          <h2>Mapa de vistas de la consola</h2>
          <div style={{ display: 'grid', gap: '12px', marginTop: '12px' }}>
            <div>
              <strong>Portada (<code>/</code>)</strong>
              <p className="muted" style={{ margin: '4px 0 0' }}>
                Resumen ejecutivo de la flota, estado de colas, consumo de cuotas y alertas operativas prioritarias.
              </p>
            </div>
            <div>
              <strong>La flota ahora (<code>/live</code>)</strong>
              <p className="muted" style={{ margin: '4px 0 0' }}>
                Hipergrafo en tiempo real y cajón de cada agente. «Contexto» es el único lugar para
                modificar su perfil canónico y su manual; «Ficheros» es un visor de lo materializado.
              </p>
            </div>
            <div>
              <strong>Cuentas y cuotas (<code>/accounts</code>)</strong>
              <p className="muted" style={{ margin: '4px 0 0' }}>
                Único lugar para registrar o retirar cuentas de proveedores y modificar sus techos
                y bindings de fallback, además de consultar límites y consumo.
              </p>
            </div>
            <div>
              <strong>Mensajes (<code>/messages</code>)</strong>
              <p className="muted" style={{ margin: '4px 0 0' }}>
                Único lugar para redactar y publicar mensajes durables. Muestra el estado de sus
                entregas y deriva cualquier rescate operativo a Colas.
              </p>
            </div>
            <div>
              <strong>Queues &amp; DLQ (<code>/queues</code>)</strong>
              <p className="muted" style={{ margin: '4px 0 0' }}>
                Único lugar para reinyectar, cancelar o resolver entregas, con confirmación,
                recibo exacto y relectura ante un resultado incierto.
              </p>
            </div>
            <div>
              <strong>Señales y auditoría (<code>/observability</code>)</strong>
              <p className="muted" style={{ margin: '4px 0 0' }}>
                Eventos auditables del bus, métricas del gateway, egress hacia clientes y trazas de auditoría firmadas.
              </p>
            </div>
            <div>
              <strong>Ajustes y altas (<code>/config</code>)</strong>
              <p className="muted" style={{ margin: '4px 0 0' }}>
                Control atómico de topología: tenants, salas, membresías, roles de permisos y ACL,
                con historial de revisiones y reversión segura. No edita contextos ni el pool de
                cuentas: esas escrituras pertenecen a Contexto y Cuentas y cuotas.
              </p>
            </div>
            <div>
              <strong>Terminal de agentes (<code>/terminal</code>)</strong>
              <p className="muted" style={{ margin: '4px 0 0' }}>
                Consola PTY por agente con feed durable y ACK en sólo lectura. Sus enlaces profundos
                llevan a Mensajes para publicar y a Colas para rescatar una entrega.
              </p>
            </div>
          </div>
        </div>

        <div className="card">
          <h2>Contexto, capacidades y permisos</h2>
          <div style={{ display: 'grid', gap: '12px', marginTop: '12px' }}>
            <div>
              <strong>Contexto declarado</strong>: propósito, rol, responsabilidades, restricciones,
              herramientas declaradas y reglas estables que se redactan en «Contexto».
            </div>
            <div>
              <strong>Capacidades del runtime</strong>: lo que el proceso acredita que sabe hacer;
              describir una herramienta en el contexto no habilita un binario ni un MCP.
            </div>
            <div>
              <strong>Permisos efectivos</strong>: membresías, roles de permisos, ACL y RBAC deciden
              qué operaciones están autorizadas. No salen del texto del contexto.
            </div>
            <div>
              <strong>Ficheros</strong>: inventario y lectura diagnóstica. Si un contexto se puede
              modificar desde la consola, el control vive en «Contexto», no en este visor.
            </div>
          </div>
        </div>

        <div className="card">
          <h2>Estados de la flota y ciclo de entrega</h2>
          <div style={{ display: 'grid', gap: '12px', marginTop: '12px' }}>
            <div>
              <strong>in_flight</strong>: El agente está ejecutando un turno de procesamiento activo.
            </div>
            <div>
              <strong>idle</strong>: El agente está conectado y listo para recibir turnos de ejecución.
            </div>
            <div>
              <strong>degraded</strong>: El arnés del agente reporta limitaciones o fallas parciales.
            </div>
            <div>
              <strong>down / off</strong>: El agente no tiene presencia activa en el bus.
            </div>
            <div>
              <strong>fenced</strong>: La entrega fue revocada debido a expiración de lease o desconexión concurrente.
            </div>
          </div>
        </div>

        <div className="card">
          <h2>Atajos de teclado y navegación</h2>
          <div style={{ display: 'grid', gap: '12px', marginTop: '12px' }}>
            <div>
              <kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>B</kbd>: Pliega y despliega la barra lateral.
            </div>
            <div>
              <kbd>Esc</kbd>: Cierra modales activos, cajones de detalle de agente e inspectores.
            </div>
            <div>
              <kbd>Enter</kbd>: Confirma formularios y filtros de búsqueda.
            </div>
            <div>
              <kbd>Ctrl</kbd> + Clic / <kbd>Cmd</kbd> + Clic: Abre enlaces en una pestaña independiente.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
