#!/usr/bin/python3
import argparse
import fcntl
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import ssl
import stat
import subprocess
import sys
import tempfile
import urllib.parse


LOCAL_SEED = Path('/run/dev-workspace/local-startos.json')
NAME = re.compile(r'[a-z0-9][a-z0-9_-]{0,47}\Z')
CERTIFICATE = re.compile(r'-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----')
REMOTE_COMMANDS = frozenset(('auth', 'backup', 'db', 'diagnostic', 'disk', 'echo', 'init', 'kiosk', 'net', 'notification', 'package', 'server', 'setup', 'ssh', 'state', 'wifi', 'help', '--help', '-h'))
GLOBAL_OPTIONS = frozenset(('--config', '--host', '--registry', '--registry-hostname', '--s9pk-s3base', '--s9pk-s3bucket', '--tunnel', '--proxy', '--id-key-path', '--developer-key-path', '--id-key-gpg', '--root-ca', '--insecure'))


class TargetError(Exception):
    pass


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise TargetError('Invalid arguments. Run startos-target --help.')


def valid_name(value):
    if not isinstance(value, str) or NAME.fullmatch(value) is None:
        raise TargetError('Target names must use 1 to 48 lowercase letters, digits, underscores or hyphens, starting with a letter or digit.')
    return value


def valid_url(value):
    if not isinstance(value, str) or len(value) > 2048 or any(ord(character) < 33 or ord(character) > 126 for character in value):
        raise TargetError('A valid HTTPS server URL without credentials, query, fragment or path is required.')
    try:
        parsed = urllib.parse.urlsplit(value)
        hostname = parsed.hostname
        port = parsed.port
        if parsed.scheme != 'https' or not hostname or parsed.username is not None or parsed.password is not None or parsed.path not in ('', '/') or any(character in value for character in ('?', '#', '\\', '%')):
            raise ValueError
        authority = r'\[[0-9A-Fa-f:.]+\](?::[0-9]+)?' if parsed.netloc.startswith('[') else r'[A-Za-z0-9.-]+(?::[0-9]+)?'
        if re.fullmatch(authority, parsed.netloc) is None:
            raise ValueError
        if port is not None and not 1 <= port <= 65535:
            raise ValueError
        try:
            address = ipaddress.ip_address(hostname)
            hostname = '[' + str(address) + ']' if address.version == 6 else str(address)
        except ValueError:
            if ':' in hostname or any(not label or len(label) > 63 or re.fullmatch(r'[a-z0-9](?:[a-z0-9-]*[a-z0-9])?', label) is None for label in hostname.rstrip('.').split('.')):
                raise ValueError
        return 'https://' + hostname + (':' + str(port) if port is not None and port != 443 else '')
    except ValueError:
        raise TargetError('A valid HTTPS server URL without credentials, query, fragment or path is required.') from None


def public_ca(value):
    if not isinstance(value, str) or len(value) > 131072:
        raise TargetError('A valid public CA certificate file is required.')
    blocks = CERTIFICATE.findall(value)
    if not blocks or CERTIFICATE.sub('', value).strip():
        raise TargetError('The CA file must contain only public CA certificates.')
    try:
        certificates = [ssl.PEM_cert_to_DER_cert(block) for block in blocks]
        canonical = ''.join(ssl.DER_cert_to_PEM_cert(certificate) for certificate in certificates)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.load_verify_locations(cadata=canonical)
        if context.cert_store_stats()['x509_ca'] < 1:
            raise ValueError
    except (ValueError, ssl.SSLError):
        raise TargetError('A valid public CA certificate file is required.') from None
    return canonical


def private_directory(path, create=False):
    if create:
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
    metadata = path.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.geteuid() or metadata.st_mode & 0o077:
        raise TargetError('Target storage must be a private directory owned by the current user.')
    return path


def targets_root(create=False):
    configured = os.environ.get('XDG_CONFIG_HOME')
    base = Path(configured) if configured else Path.home() / '.config'
    if not base.is_absolute():
        raise TargetError('XDG_CONFIG_HOME must be an absolute directory.')
    for parent in (base, *base.parents):
        if parent.is_symlink():
            raise TargetError('Target storage must not use symbolic links.')
    namespace = base / 'dev-workspace'
    target = namespace / 'startos' / 'targets'
    if not create and not target.exists():
        if target.is_symlink():
            raise TargetError('Target storage must not use symbolic links.')
        return target
    for path in (namespace, namespace / 'startos', target):
        private_directory(path, create)
    return target


def read_file(path, limit, owner=None, private=False):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > limit or (owner is not None and metadata.st_uid != owner) or metadata.st_mode & (0o077 if private else 0o022):
            raise TargetError('The requested file is not a safe regular file.')
        with os.fdopen(descriptor, 'rb', closefd=False) as source:
            contents = source.read(limit + 1)
        if len(contents) > limit:
            raise TargetError('The requested file is too large.')
        return contents.decode('utf-8')
    finally:
        os.close(descriptor)


def json_object(value):
    def object_pairs(pairs):
        result = {}
        for key, item in pairs:
            if key in result:
                raise TargetError('The target configuration is invalid.')
            result[key] = item
        return result
    result = json.loads(value, object_pairs_hook=object_pairs)
    if not isinstance(result, dict):
        raise TargetError('The target configuration is invalid.')
    return result


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_private(path, contents):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    with os.fdopen(descriptor, 'w') as output:
        output.write(contents)
        output.flush()
        os.fsync(output.fileno())


def identity_present(directory):
    path = directory / 'id.key.pem'
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return False
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid() or metadata.st_mode & 0o077:
        raise TargetError('The target identity must be a private regular file owned by the current user.')
    return True


def load_target(name):
    name = valid_name(name)
    directory = private_directory(targets_root() / name)
    config = json_object(read_file(directory / 'config.json', 8192, os.geteuid(), True))
    if set(config) != {'version', 'name', 'url', 'rootCaSha256'} or config['version'] != 1 or config['name'] != name or valid_url(config['url']) != config['url']:
        raise TargetError('The target configuration is invalid.')
    certificate = public_ca(read_file(directory / 'root-ca.pem', 131072, os.geteuid(), True))
    if hashlib.sha256(certificate.encode()).hexdigest() != config['rootCaSha256']:
        raise TargetError('The target CA does not match its saved configuration.')
    return directory, config, certificate


def information(name):
    directory, config, certificate = load_target(name)
    return {
        'name': config['name'],
        'url': config['url'],
        'rootCaSha256': config['rootCaSha256'],
        'certificateFingerprints': [hashlib.sha256(ssl.PEM_cert_to_DER_cert(block)).hexdigest() for block in CERTIFICATE.findall(certificate)],
        'identityPresent': identity_present(directory),
    }


def add_target(name, url, certificate):
    name, url, certificate = valid_name(name), valid_url(url), public_ca(certificate)
    root = targets_root(True)
    destination = root / name
    config = {'version': 1, 'name': name, 'url': url, 'rootCaSha256': hashlib.sha256(certificate.encode()).hexdigest()}
    descriptor = os.open(root / '.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid() or metadata.st_mode & 0o077:
            raise TargetError('Target storage lock is unsafe.')
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        if os.path.lexists(destination):
            _, existing, _ = load_target(name)
            if existing != config:
                raise TargetError('This target already has a different server or CA. Choose a new target name.')
            return information(name)
        staging = Path(tempfile.mkdtemp(prefix='.new-target-', dir=root))
        try:
            write_private(staging / 'config.json', json.dumps(config, indent=2) + '\n')
            write_private(staging / 'root-ca.pem', certificate)
            sync_directory(staging)
            os.rename(staging, destination)
            sync_directory(root)
        finally:
            if staging.exists():
                shutil.rmtree(staging)
        return information(name)
    finally:
        os.close(descriptor)


def add_local(name):
    metadata = LOCAL_SEED.parent.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o022:
        raise TargetError('The local StartOS connection information is unavailable.')
    seed = json_object(read_file(LOCAL_SEED, 140000, 0))
    if set(seed) != {'version', 'url', 'rootCa'} or seed['version'] != 1:
        raise TargetError('The local StartOS connection information is invalid.')
    url, certificate = valid_url(seed['url']), public_ca(seed['rootCa'])
    parsed = urllib.parse.urlsplit(url)
    context = ssl.create_default_context(cadata=certificate)
    connection = http.client.HTTPSConnection(parsed.hostname, parsed.port or 443, context=context, timeout=5)
    try:
        connection.request('GET', '/')
        response = connection.getresponse()
        if not 200 <= response.status < 300:
            raise TargetError('The local StartOS server could not be verified over HTTPS.')
    except (OSError, http.client.HTTPException):
        raise TargetError('The local StartOS server could not be verified over HTTPS.') from None
    finally:
        connection.close()
    return add_target(name, url, certificate)


def command_arguments(arguments):
    if not arguments or arguments[0] not in REMOTE_COMMANDS:
        raise TargetError('Choose a StartOS server command. Run packaging and registry commands with start-cli directly.')
    if arguments[0] == 'auth' and 'login' in arguments[1:]:
        raise TargetError('Use startos-target login to enroll this target interactively.')
    for argument in arguments:
        option = argument.split('=', 1)[0]
        if option in GLOBAL_OPTIONS or (argument.startswith('-') and not argument.startswith('--') and len(argument) > 1 and argument[1] in 'Hcrpt'):
            raise TargetError('Target, identity, configuration, proxy and TLS options cannot be overridden.')
        if argument.startswith('-') and any(word in option.lower() for word in ('password', 'passphrase')):
            raise TargetError('Passwords must not be supplied as command arguments.')
    return arguments


def cli_arguments(name):
    directory, config, _ = load_target(name)
    identity_present(directory)
    for path in (Path.home() / '.startos/config.yaml', Path('/etc/startos/config.yaml'), Path('/run/startos/id.key.pem'), directory / 'developer.key.pem'):
        if os.path.lexists(path):
            raise TargetError('Ambient StartOS configuration or an alternate identity prevents isolated access. Use start-cli directly or a workspace without that configuration.')
    executable = shutil.which('start-cli')
    if executable is None:
        raise TargetError('start-cli is not installed or is unavailable on PATH.')
    return directory, [executable, '-H', config['url'], '--root-ca', str(directory / 'root-ca.pem'), '--id-key-path', str(directory / 'id.key.pem')]


def cli_environment():
    environment = os.environ.copy()
    for name in ('PASSWORD', 'BACKUP_PASSWORD', 'CIFS_PASSWORD'):
        environment.pop(name, None)
    return environment


def run_command(name, arguments):
    arguments = command_arguments(arguments)
    directory, command = cli_arguments(name)
    standard_input = subprocess.DEVNULL if sys.stdin.isatty() else None
    process = subprocess.Popen(command + arguments, cwd=directory, env=cli_environment(), stdin=standard_input, stderr=subprocess.PIPE)
    diagnostic = bytearray()
    try:
        while chunk := process.stderr.read(4096):
            diagnostic.extend(chunk)
            del diagnostic[:-16384]
        code = process.wait()
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        process.stderr.close()
    if code:
        message = diagnostic.decode('utf-8', 'replace').lower()
        if any(word in message for word in ('not logged in', 'unauthorized', 'authorization', 'key not authorized', 'identity key does not exist')):
            raise TargetError('StartOS rejected this target identity. Run startos-target login ' + name + ' from an interactive terminal.')
        if any(word in message for word in ('certificate', 'tls', 'ssl')):
            raise TargetError('StartOS HTTPS verification failed. Check the saved server address and public CA.')
        if any(word in message for word in ('failed to resolve', 'connection refused', 'timed out', 'timeout', 'network error')):
            raise TargetError('The StartOS server could not be reached. Check its address, network access and service state.')
        raise TargetError('The StartOS command failed with exit code ' + str(code) + '. Use command help and check the target state; diagnostic details were withheld.')
    return None


def login(name):
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        raise TargetError('Login requires an interactive terminal. Run startos-target login from your terminal.')
    directory, command = cli_arguments(name)
    os.chdir(directory)
    os.execve(command[0], command + ['auth', 'login'], cli_environment())


def main():
    os.umask(0o077)
    parser = Parser(prog='startos-target', description='Save verified HTTPS targets and enroll a separate StartOS identity interactively.')
    subcommands = parser.add_subparsers(dest='operation', required=True)
    add = subcommands.add_parser('add', help='Save a server URL and public CA without logging in')
    add.add_argument('name')
    add.add_argument('--url', required=True)
    add.add_argument('--ca-file', required=True, type=Path)
    local = subcommands.add_parser('add-local', help='Discover and verify this workspace server without logging in')
    local.add_argument('name', nargs='?', default='local-server')
    for operation in ('login', 'info'):
        command = subcommands.add_parser(operation)
        command.add_argument('name')
    subcommands.add_parser('list', help='Show public target metadata')
    run = subcommands.add_parser('run', help='Run a noninteractive server command with a saved target')
    run.add_argument('name')
    run.add_argument('arguments', nargs=argparse.REMAINDER)
    try:
        arguments = parser.parse_args()
        if arguments.operation == 'add':
            result = add_target(arguments.name, arguments.url, read_file(arguments.ca_file, 131072))
        elif arguments.operation == 'add-local':
            result = add_local(valid_name(arguments.name))
        elif arguments.operation == 'info':
            result = information(arguments.name)
        elif arguments.operation == 'list':
            root = targets_root()
            result = [information(entry.name) for entry in sorted(root.iterdir()) if not entry.name.startswith('.')] if root.exists() else []
        elif arguments.operation == 'login':
            return login(arguments.name)
        else:
            return run_command(arguments.name, arguments.arguments)
        print(json.dumps(result, separators=(',', ':')))
        return 0
    except TargetError as error:
        print(str(error), file=sys.stderr)
    except (OSError, ValueError, KeyError, TypeError, ssl.SSLError):
        print('StartOS target access is unavailable. Check the saved target, public CA and file permissions.', file=sys.stderr)
    except KeyboardInterrupt:
        print('StartOS target command interrupted.', file=sys.stderr)
        return 130
    return 1


if __name__ == '__main__':
    sys.exit(main())
