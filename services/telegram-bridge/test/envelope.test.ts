import { describe, expect, it } from 'vitest';
import { telegramTextChunks, unwrapStructuredEnvelope } from '../src/egress.js';

describe('red de seguridad contra el volcado de la salida estructurada', () => {
  it('rescata el reply cuando el objeto viene precedido de prosa', () => {
    const crudo = 'Told Steven (msg 6151, clean). Routing the credential swap to zeus.\n\n'
      + '{"reply":"Arreglado y verificado.","messages":[],"status":"done","retryable":false,"artifacts":[]}';
    expect(unwrapStructuredEnvelope(crudo)).toBe('Arreglado y verificado.');
  });

  it('usa la prosa cuando el agente dejó el reply en null', () => {
    const crudo = 'Told Steven (msg 6151, clean). Routing the credential swap to zeus.\n\n'
      + '{"reply":null,"messages":[{"to":"zeus","body":"INFRA URGENTE"}],"status":"done","artifacts":[]}';
    expect(unwrapStructuredEnvelope(crudo)).toBe('Told Steven (msg 6151, clean). Routing the credential swap to zeus.');
  });

  it('rescata el reply de una valla de código', () => {
    const crudo = '```json\n{"reply":"E2E ejecutado de verdad.","messages":[],"status":"done","artifacts":[]}\n```';
    expect(unwrapStructuredEnvelope(crudo)).toBe('E2E ejecutado de verdad.');
  });

  it('rescata el objeto crudo sin envoltura', () => {
    const crudo = '{"reply":"Confirmado el encuadre.","messages":[],"status":"done","artifacts":[]}';
    expect(unwrapStructuredEnvelope(crudo)).toBe('Confirmado el encuadre.');
  });

  /* --- Lo que NO se debe tocar: publicar de más es feo, tragarse una respuesta es peor --- */

  it('no toca un mensaje que sólo CITA un JSON y sigue hablando', () => {
    const texto = 'El adaptador devolvió {"reply":"x","status":"done"} y por eso falló el parseo. Revisalo.';
    expect(unwrapStructuredEnvelope(texto)).toBe(texto);
  });

  it('no toca un objeto que no tiene la forma del contrato', () => {
    const texto = '{"nombre":"graf","url":"https://dev.graf.com.co"}';
    expect(unwrapStructuredEnvelope(texto)).toBe(texto);
  });

  it('no toca un objeto con reply pero sin ningún otro campo del protocolo', () => {
    const texto = '{"reply":"esto es un ejemplo de payload"}';
    expect(unwrapStructuredEnvelope(texto)).toBe(texto);
  });

  it('no toca texto normal, ni el que contiene llaves sueltas', () => {
    expect(unwrapStructuredEnvelope('hola, todo listo')).toBe('hola, todo listo');
    expect(unwrapStructuredEnvelope('usá ${VAR} en el template {ojo}')).toBe('usá ${VAR} en el template {ojo}');
  });

  it('no se confunde con llaves dentro de cadenas del propio JSON', () => {
    const crudo = '{"reply":"usá la sintaxis {campo} en el template","messages":[],"status":"done"}';
    expect(unwrapStructuredEnvelope(crudo)).toBe('usá la sintaxis {campo} en el template');
  });

  it('devuelve el texto intacto si el objeto está truncado', () => {
    const texto = 'algo pasó {"reply":"a medio escribir';
    expect(unwrapStructuredEnvelope(texto)).toBe(texto);
  });

  it('se aplica de punta a punta sobre lo que realmente se envía a Telegram', () => {
    const chunks = telegramTextChunks({
      result: { output: { reply: '```json\n{"reply":"Listo.","messages":[],"status":"done"}\n```' } }
    });
    expect(chunks).toEqual(['Listo.']);
  });
});
