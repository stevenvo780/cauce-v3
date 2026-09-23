import { errorLabel, logEvent } from '@cauce/protocol';
import { loadConfig } from './config.js';
import { startService } from './server.js';

/* The key file is readable by the service user only; running as root would be a packaging accident. */
if (process.getuid?.() === 0) {
  logEvent('decisiones_rechazado', { reason: 'root_euid' });
  process.exit(78);
}

try {
  const config = loadConfig();
  const running = await startService(config);
  logEvent('decisiones_escuchando', {
    port: running.port,
    modelo: config.jev.model,
    aliases_habilitados: config.allowedAliases === undefined ? 'todos' : [...config.allowedAliases].join(','),
  }, { level: 'info' });
  const stop = (signal: string): void => {
    logEvent('decisiones_apagando', { signal }, { level: 'info' });
    void running.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.once('SIGTERM', () => { stop('SIGTERM'); });
  process.once('SIGINT', () => { stop('SIGINT'); });
} catch (error) {
  logEvent('decisiones_arranque_fallido', { error: errorLabel(error) });
  process.exit(1);
}
