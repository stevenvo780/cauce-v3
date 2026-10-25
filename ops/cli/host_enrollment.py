from __future__ import annotations

import argparse
import base64
import errno
import hashlib
import json
import pathlib
import platform
import re
import subprocess
import sys
import uuid

from host_channel_client import (
    HostChannel,
    HostFailure,
    ensure_key,
    gateway_url,
    post_json,
    private_directory,
    private_file,
    save_private,
    sign,
    stable_json,
)


class HostArgumentParser(argparse.ArgumentParser):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, add_help=False, **kwargs)
        self.add_argument('-h', '--help', action='help', help='Muestra esta ayuda y termina.')
        self._positionals.title = 'argumentos'
        self._optionals.title = 'opciones'

    def format_help(self):
        return super().format_help().replace('usage: ', 'Uso: ', 1)

    def format_usage(self):
        return super().format_usage().replace('usage: ', 'Uso: ', 1)

    def error(self, _message):
        self.print_usage(sys.stderr)
        self.exit(2, 'Argumentos de hosts inválidos; usa cauce hosts --help.\n')


def invitation_from_stdin() -> dict:
    raw = sys.stdin.buffer.read(8193)
    if len(raw) > 8192:
        raise HostFailure('invitation exceeds its limit')
    try:
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError()
        uuid.UUID(value['enrollment_id'])
        for key in ('company_id', 'host_id'):
            if not isinstance(value[key], str) or re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', value[key]) is None:
                raise ValueError()
        for key in ('nonce', 'invitation_token'):
            if not isinstance(value[key], str) or re.fullmatch(r'[a-f0-9]{64}', value[key]) is None:
                raise ValueError()
        if value['state'] != 'pending':
            raise ValueError()
        anchor = value.get('setup_signer_fingerprint')
        if anchor is not None and (not isinstance(anchor, str) or re.fullmatch(r'[a-f0-9]{64}', anchor) is None):
            raise ValueError()
        return value
    except (ValueError, KeyError, TypeError):
        raise HostFailure('paste the complete pending invitation JSON from the console') from None


def enroll(gateway: str, invitation: dict, state_root: pathlib.Path) -> dict:
    gateway = gateway_url(gateway)
    from host_setup import reject_other_company
    reject_other_company(state_root, invitation['company_id'], state_root)
    directory = private_directory(state_root / invitation['company_id'] / invitation['host_id'])
    identity_file = directory / 'identity.json'
    fingerprint = hashlib.sha256(ensure_key(directory)).hexdigest()
    pending = {key: invitation[key] for key in ('enrollment_id', 'company_id', 'host_id')}
    pending.update(gateway=gateway, state='pending', key_fingerprint=fingerprint)
    if identity_file.exists() or identity_file.is_symlink():
        previous = json.loads(private_file(identity_file))
        if any(previous.get(key) != pending[key] for key in ('gateway', 'enrollment_id', 'company_id', 'host_id', 'key_fingerprint')):
            raise HostFailure('local host identity belongs to another enrollment; it was retained')
        if previous.get('state') == 'enrolled':
            return {key: previous[key] for key in ('company_id', 'host_id', 'state', 'key_fingerprint', 'executor_ready')}
    if invitation.get('setup_signer_fingerprint') is not None:
        from host_setup import anchor_signer
        anchor_signer(directory, invitation['setup_signer_fingerprint'])
    save_private(identity_file, pending)
    message = {key: invitation[key] for key in ('enrollment_id', 'company_id', 'host_id', 'nonce')}
    message['version'] = 1
    request = {'invitation_token': invitation['invitation_token'],
        'public_key': base64.b64encode(ensure_key(directory)).decode(), 'proof': sign(directory, stable_json(message))}
    receipt = post_json(gateway, '/v3/fleet/hosts/enrollments/' + invitation['enrollment_id'] + '/claim', request)
    if any(receipt.get(key) != pending[key] for key in ('enrollment_id', 'company_id', 'host_id', 'key_fingerprint')) \
            or receipt.get('state') != 'enrolled' or not isinstance(receipt.get('executor_ready'), bool):
        raise HostFailure('enrollment response does not match this local identity; retry is safe')
    save_private(identity_file, {**pending, **receipt, 'gateway': gateway})
    return receipt


def heartbeat(directory: pathlib.Path) -> dict:
    channel = HostChannel(directory)
    docker_version = None
    try:
        result = subprocess.run(['docker', 'version', '--format', '{{.Server.Version}}'],
            capture_output=True, timeout=10, check=False)
        if result.returncode == 0:
            candidate = result.stdout.decode().strip()
            if re.fullmatch(r'[A-Za-z0-9_.+-]{1,128}', candidate):
                docker_version = candidate
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return channel.request('POST', '/v3/fleet/hosts/' + channel.identity['host_id'] + '/heartbeat',
        {'cli_version': '4.0.0', 'platform': platform.system() + '/' + platform.machine(),
            'docker_version': docker_version, 'status': 'reachable'})


def failure_reason(error: Exception) -> str:
    if isinstance(error, subprocess.TimeoutExpired):
        reason = 'un subproceso superó su tiempo límite; revisa el executor y sus dependencias'
    elif isinstance(error, subprocess.CalledProcessError):
        reason = f'un subproceso terminó con código {error.returncode}'
    elif isinstance(error, OSError):
        reason = errno.errorcode.get(error.errno, 'error de E/S') + '; revisa archivos, ejecutables y permisos locales'
    elif isinstance(error, json.JSONDecodeError):
        reason = f'JSON inválido en la línea {error.lineno}, columna {error.colno}'
    elif isinstance(error, UnicodeError):
        reason = 'texto con codificación inválida'
    else:
        reason = 'datos o configuración local inválidos'
    return type(error).__name__ + ': ' + reason


def host_failure_message(error: HostFailure) -> str:
    message = str(error)
    rejected = re.fullmatch(
        r'executor policy was written but the executor rejects it \(([^\r\n]{1,2048})\); service not started', message)
    if rejected:
        from host_setup import setup_diagnostic
        detail = setup_diagnostic(rejected[1])
        if detail is not None:
            return ('La política se guardó, pero el executor la rechazó: ' + detail[0] + ' en ' + detail[1]
                + '. Revisa ese componente y repite cauce hosts setup. No se inició el servicio.')
        return ('La política se guardó, pero el executor la rechazó: executor_diagnostic_unavailable en capabilities. '
            'No se recibió una causa verificable. No se inició el servicio.')
    known = {
        'invitation exceeds its limit': 'La invitación supera el tamaño permitido; copia el JSON completo desde la consola.',
        'paste the complete pending invitation JSON from the console': 'Copia desde la consola el JSON completo de una invitación pendiente.',
        'local host identity belongs to another enrollment; it was retained': 'La identidad local pertenece a otro enrolamiento; usa su directorio original o una invitación nueva.',
        'enrollment response does not match this local identity; retry is safe': 'El recibo no coincide con la identidad local; revisa el ordenador en la consola antes de reintentar.',
        'pass --identity-directory: expected exactly one enrolled identity under the state root': 'Indica --identity-directory con el directorio de la identidad enrolada que quieres usar.',
        'setup signer fingerprint must be 64 lowercase hex characters': 'La huella del firmante debe tener 64 caracteres hexadecimales en minúscula; cópiala desde la consola.',
        'setup package signer differs from the anchored one; nothing was installed': 'El firmante del paquete no coincide con la huella guardada; consulta al administrador antes de reintentar.',
        'setup package signature is invalid; nothing was installed': 'La firma del paquete no es válida; consulta al administrador y vuelve a descargar el paquete firmado.',
        'setup package is stale or belongs to another computer': 'El paquete venció o pertenece a otro ordenador; solicita un paquete nuevo desde la consola.',
        'gateway did not return a signed setup package': 'El gateway no entregó un paquete firmado; consulta al administrador de la plataforma.',
        'host request unavailable; local identity retained for retry': 'No se pudo conectar con el gateway; revisa la red, los certificados y --gateway antes de reintentar.',
        'host identity directory cannot contain symlinks': 'La ruta de identidad no admite enlaces simbólicos; indica un directorio propio con --identity-directory.',
        'host identity directory must belong to the current user with mode 0700': 'El directorio de identidad debe pertenecer a tu usuario y tener permisos 700.',
        'host identity file must belong to the current user with mode 0600': 'Los archivos de identidad deben pertenecer a tu usuario y tener permisos 600.',
        'host must finish enrollment before sending signed operations': 'Completa el enrolamiento en la consola antes de usar el canal firmado.',
        'Node.js 22 or newer is required to run the executor service': 'Instala Node.js 22 o posterior antes de repetir cauce hosts setup.',
        'setup package signature is malformed': 'La firma del paquete tiene un formato inválido; solicita un paquete firmado nuevo. No se instaló nada.',
        'setup package must be signed with Ed25519': 'El paquete requiere una firma Ed25519; solicita un paquete firmado compatible. No se instaló nada.',
        'setup package must carry one release and a policy': 'El paquete debe incluir una versión del executor y su política; solicita un paquete completo. No se instaló nada.',
        'setup package artifact is invalid': 'El paquete contiene un artefacto inválido; solicita un paquete firmado nuevo. No se instaló nada.',
        'setup package may carry one agent image and one quota image': 'El paquete admite una imagen de agentes y una de cuotas; solicita un paquete compatible. No se instaló nada.',
        'quota environments do not use the quota image signed by the package; nothing was installed': 'Los entornos de cuotas no usan la imagen firmada del paquete; solicita un paquete coherente. No se instaló nada.',
        'release archive contains an unsafe entry': 'El archivo del executor contiene una ruta insegura; solicita un paquete firmado nuevo. No se inició el servicio.',
        'release archive expands beyond its limit': 'El archivo del executor supera el tamaño permitido al extraerse; solicita un paquete compatible. No se inició el servicio.',
        'approved bundle digest differs from the release; nothing was activated': 'El digest del bundle aprobado no coincide con el executor del paquete; solicita un paquete coherente. No se activó nada.',
        'approved bundle cannot be verified in the release': 'No se pudo verificar la integridad del bundle aprobado en el executor; solicita un paquete completo y coherente. No se activó nada.',
        'setup policy cannot override local identity or roots': 'La política del paquete intenta sustituir la identidad o las rutas locales; solicita una política compatible. No se inició el servicio.',
        'setup policy cannot add native runtimes': 'La política del paquete intenta añadir runtimes nativos no permitidos; solicita una política compatible. No se inició el servicio.',
        'enrolled identity has ids that cannot name a service': 'La identidad enrolada no permite nombrar el servicio de usuario; solicita una invitación compatible.',
        'gateway must be an origin without credentials, query or path': 'El gateway debe ser un origen sin credenciales, consultas ni rutas; revisa --gateway y la invitación.',
        'gateway requires verified HTTPS; HTTP is restricted to loopback tests': 'El gateway requiere HTTPS verificado; HTTP solo se admite en pruebas locales. Revisa --gateway y los certificados.',
        'gateway hostname is required': 'Falta el nombre del gateway; revisa --gateway y la invitación.',
    }
    if message in known:
        return known[message]
    setup_diagnostics = (
        (r'approved descriptor pin is invalid for [a-z][a-z0-9_-]{0,63}; nothing was activated',
            'La huella del descriptor aprobado no es válida; solicita un paquete coherente. No se activó nada.'),
        (r'approved descriptor differs for [a-z][a-z0-9_-]{0,63}; nothing was activated',
            'El descriptor aprobado no coincide con su huella en el paquete; solicita un paquete coherente. No se activó nada.'),
        (r'release does not contain a private provider login helper \(ops/(?:cli|container-runtime)/[a-zA-Z0-9_.-]{1,128}\); service not started',
            'El executor del paquete no incluye un helper privado de autenticación válido; solicita un paquete completo con permisos correctos. No se inició el servicio.'),
        (r'release does not contain [a-zA-Z0-9_./-]{1,256}',
            'El archivo del executor está incompleto; solicita un paquete firmado completo. No se inició el servicio.'),
        (r'la plantilla de contenedor [^\r\n]{0,2048} no usa la imagen de agentes que trae el paquete \(sha256:[a-f0-9]{64}\); no se instaló nada',
            'La plantilla de contenedor no usa la imagen de agentes del paquete firmado; pide al administrador que publique un paquete coherente. No se instaló nada.'),
        (r'el gateway respondió a la descarga de [a-z][a-z0-9_-]{0,63} desde otra posición; no se instaló nada',
            'El gateway devolvió una posición de descarga distinta de la solicitada; repite cauce hosts setup para descargar el paquete completo. No se instaló nada.'),
        (r'[a-z][a-z0-9_-]{0,63} supera el tamaño firmado en el paquete; no se instaló nada',
            'La descarga supera el tamaño firmado; solicita un paquete nuevo antes de repetir cauce hosts setup. No se instaló nada.'),
        (r'no se pudo descargar [a-z][a-z0-9_-]{0,63} del gateway tras [0-9]{1,6} intentos; revisa la conexión y repite cauce hosts setup \(es seguro\)',
            'La descarga falló después de los reintentos; revisa la conexión y repite cauce hosts setup.'),
        (r'Docker no está en /[A-Za-z0-9_./-]+: instala el paquete docker\.io o docker-ce \(no el snap\) y repite',
            'Docker no está disponible; instala docker.io o docker-ce y repite cauce hosts setup.'),
        (r'Docker no respondió al consultar la imagen de agentes \([\s\S]{0,200}\); comprueba que este usuario está en el grupo docker',
            'Docker no respondió al consultar la imagen de agentes; comprueba que el servicio Docker está disponible y que este usuario pertenece al grupo docker.'),
        (r'Docker no pudo inspeccionar la imagen de agentes: [\s\S]{0,200}',
            'Docker no pudo inspeccionar la imagen de agentes; revisa el servicio Docker y los permisos de este usuario antes de repetir cauce hosts setup.'),
        (r'Docker no devolvió un Id inmutable para la imagen de agentes',
            'Docker no acredita un identificador inmutable para la imagen de agentes; revisa la imagen local y repite cauce hosts setup.'),
        (r'Docker no pudo verificar la configuración de la imagen de agentes',
            'Docker no pudo verificar la configuración de la imagen de agentes; revisa los permisos y el espacio en disco antes de repetir cauce hosts setup.'),
        (r'docker load no terminó en [0-9]{1,6} minutos; repite cauce hosts setup',
            'La carga de la imagen en Docker superó el tiempo límite; revisa Docker y repite cauce hosts setup.'),
        (r'docker load rechazó la imagen de agentes \([\s\S]{0,200}\); revisa el espacio en disco\. No se arrancó el servicio',
            'Docker rechazó la carga de la imagen de agentes; revisa el espacio en disco y repite cauce hosts setup. No se inició el servicio.'),
        (r'Docker no pudo conservar la referencia a la imagen verificada; no se arrancó el servicio',
            'Docker no pudo conservar la referencia a la imagen verificada; revisa el almacenamiento de Docker y repite cauce hosts setup. No se inició el servicio.'),
        (r'la imagen cargada no tiene la configuración del tar firmado; no se arrancó el servicio',
            'La imagen cargada no coincide con la configuración del archivo firmado; solicita un paquete nuevo y repite cauce hosts setup. No se inició el servicio.'),
        (r'cannot verify image archive: [\s\S]{0,8192}',
            'No se pudo verificar la integridad del archivo de imagen; solicita un paquete firmado nuevo antes de repetir cauce hosts setup.'),
        (r'[a-z][a-z0-9_-]{0,63} no coincide con el SHA-256 firmado en el paquete; no se instaló nada',
            'La descarga no coincide con el SHA-256 firmado; solicita un paquete nuevo y repite cauce hosts setup. No se instaló nada.'),
        (r'la verificación de capacidades del executor superó [0-9]{1,6} segundos; revisa el servicio, las plantillas y la conexión con la autoridad de flota; identidad local conservada',
            'La verificación de capacidades del executor superó el tiempo límite; revisa el servicio, las plantillas y la conexión con la autoridad de flota.'),
        (r'could not start the user service; check XDG_RUNTIME_DIR and `systemctl --user status cauce-v3-host-executor-[A-Za-z0-9_.-]{1,257}\.service`',
            'No se pudo iniciar el servicio de usuario; revisa XDG_RUNTIME_DIR y consulta systemctl --user status cauce-v3-host-executor-*.'),
    )
    for pattern, diagnostic in setup_diagnostics:
        if re.fullmatch(pattern, message):
            return diagnostic
    download_status = re.fullmatch(r'el gateway rechazó la descarga de [a-z][a-z0-9_-]{0,63} \(HTTP (\d{3})\): [^\r\n]{0,512}; no se instaló nada', message)
    if download_status:
        action = {
            '404': 'Pide al administrador que publique el paquete de este despliegue.',
            '409': 'El paquete cambió durante la descarga; repite cauce hosts setup.',
            '403': 'Revisa la hora del sistema y que el ordenador siga habilitado en la consola.',
        }.get(download_status[1], 'Revisa la conexión y repite cauce hosts setup.')
        return f'El gateway rechazó la descarga (HTTP {download_status[1]}). {action} No se instaló nada.'
    status = re.fullmatch(r'host request rejected \(HTTP (\d{3})\); local identity retained', message)
    if status:
        return f'El gateway rechazó la solicitud (HTTP {status[1]}); revisa la invitación y los permisos en la consola.'
    if message.startswith('no setup signer is anchored for this computer:'):
        return 'Falta la huella del firmante; usa una invitación nueva o --signer-fingerprint con la huella mostrada en la consola.'
    if message.startswith('this gateway does not serve setup packages (HTTP 404);'):
        return 'El gateway no publica paquetes de instalación (HTTP 404); pide al administrador que configure hosts setup.'
    if message.startswith('this system user already runs the executor of company '):
        return 'Este usuario ya pertenece al executor de otra empresa; usa un usuario del sistema distinto para cada empresa.'
    return 'No se pudo verificar el enrolamiento, el paquete o el executor; revisa la identidad, los permisos y el estado en la consola.'


def main() -> int:
    parser = HostArgumentParser(prog='cauce hosts', description='Registra este ordenador con una identidad local nueva.')
    commands = parser.add_subparsers(dest='action', required=True)
    enroll_parser = commands.add_parser('enroll', help='Registra este ordenador mediante una invitación de la consola.')
    enroll_parser.add_argument('--gateway', required=True)
    enroll_parser.add_argument('--invitation-stdin', action='store_true', required=True)
    enroll_parser.add_argument('--state-root', type=pathlib.Path,
        default=pathlib.Path.home() / '.local/state/cauce-v3/hosts')
    heartbeat_parser = commands.add_parser('heartbeat', help='Informa a la consola del estado de este ordenador.')
    heartbeat_parser.add_argument('--identity-directory', type=pathlib.Path, required=True)
    for name, help_text in (('setup', 'Instala e inicia el executor como servicio de usuario de systemd.'),
                            ('status', 'Comprueba si el executor local está preparado.')):
        sub = commands.add_parser(name, help=help_text)
        sub.add_argument('--identity-directory', type=pathlib.Path)
        sub.add_argument('--state-root', type=pathlib.Path, default=pathlib.Path.home() / '.local/state/cauce-v3/hosts')
        sub.add_argument('--install-root', type=pathlib.Path, default=pathlib.Path.home() / '.local/share/cauce-v3/hosts')
        if name == 'setup':
            sub.add_argument('--dry-run', action='store_true')
            sub.add_argument('--signer-fingerprint', help='Huella del firmante mostrada en la consola, si la identidad se enroló sin ella.')
    args = parser.parse_args()
    try:
        if args.action in ('setup', 'status'):
            import host_setup
            if args.action == 'setup' and (notice := host_setup.cli_update_notice()):
                print('cauce: ' + notice, file=sys.stderr)
            identity = host_setup.locate_identity(args.state_root, args.identity_directory)
            receipt = host_setup.setup(identity, args.install_root, args.dry_run, args.signer_fingerprint) if args.action == 'setup' \
                else host_setup.status(identity, args.install_root)
            print(json.dumps(receipt, sort_keys=True))
            return 0 if args.action == 'setup' or receipt['executor_ready'] or receipt.get('space_backup_ready') else 3
        receipt = enroll(args.gateway, invitation_from_stdin(), args.state_root) if args.action == 'enroll' else heartbeat(args.identity_directory)
        print(json.dumps(receipt, sort_keys=True))
        return 0
    except HostFailure as error:
        print('cauce: ' + host_failure_message(error) + ' Identidad local conservada.', file=sys.stderr)
        return 1
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print('cauce: no se pudo completar hosts ' + args.action + '; identidad local conservada. Motivo: '
            + failure_reason(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
